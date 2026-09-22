/**
 * memark curator —— 受控记忆写入。
 *
 * 核心边界：先在临时副本校验并展示修改预览；用户确认后才触碰正式目录。
 * 所有写入按仓库串行，使用安全相对路径、精确暂存和精确回滚。
 */
import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	filenameFromTitle,
	git,
	isFormalMemoryPath,
	LAYERS,
	PROJECTS_DIR,
	REPO,
	countMd,
	readIndex,
	resolveRepoPath,
	restoreSnapshots,
	runRepoScript,
	snapshotFiles,
	unsafeWorktreeChanges,
	withRepoMutation,
	worktreeChanges,
} from "./repo";

const PERSONAL_TYPES: Record<string, string[]> = {
	identity: ["Identity"],
	principles: ["Principle"],
	preferences: ["Preference"],
	context: ["Context"],
	knowledge: ["Skill", "Experience", "Learning"],
};
const PERSONAL_SUBDIRS: Record<string, string[]> = {
	context: ["current", "relationships"],
	knowledge: ["skills", "experiences", "learnings"],
};
const PROJECT_TYPES: Record<string, string[]> = {
	decisions: ["Decision"],
	topics: ["Topic"],
	incidents: ["Incident"],
	handoffs: ["Handoff"],
};
const ALL_TYPES = ["Identity", "Principle", "Preference", "Context", "Skill", "Experience", "Learning", "Decision", "Topic", "Incident", "Handoff"] as const;
const PROJECT_TYPE_NAMES = ["Decision", "Topic", "Incident", "Handoff"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WRITE_TIMEOUT_MS = 30_000;

export interface Draft {
	title: string;
	description: string;
	body: string;
	tags: string[];
	zone: "personal" | "project";
	layer?: string;
	category?: string;
	project?: string;
	type: string;
	expires?: string;
	supersedes?: string;
	timestamp?: string;
}

interface Ctx {
	hasUI?: boolean;
	ui: {
		confirm: (title: string, message: string) => Promise<boolean>;
		notify: (message: string, tone?: "info" | "warning" | "error") => void;
	};
	cwd?: string;
}

interface WriteResult {
	success: boolean;
	deferred?: boolean;
	text: string;
}

type Changes = Map<string, string | null>;

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function validDate(value: string): boolean {
	if (!DATE_RE.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function scalar(value: string): string {
	return JSON.stringify(value);
}

function validateDraft(d: Draft): void {
	for (const [field, value] of [["title", d.title], ["description", d.description]] as const) {
		if (!value?.trim() || /[\r\n]/.test(value)) throw new Error(`${field} 必须是非空单行文字`);
	}
	if (!d.body?.trim()) throw new Error("body 不能为空");
	if (!Array.isArray(d.tags) || d.tags.length === 0) throw new Error("tags 至少需要一个标签");
	for (const tag of d.tags) {
		if (!tag.trim() || /[,\[\]\r\n]/.test(tag)) throw new Error(`标签不能包含逗号、方括号或换行：${tag}`);
	}
	if (new Set(d.tags.map((tag) => tag.trim().toLocaleLowerCase())).size !== d.tags.length) {
		throw new Error("tags 不能重复");
	}
	if (d.timestamp && !validDate(d.timestamp)) throw new Error("timestamp 须为真实的 YYYY-MM-DD 日期");
	if (d.expires && !validDate(d.expires)) throw new Error("expires 须为真实的 YYYY-MM-DD 日期");
	if (d.type === "Handoff" && !d.expires) throw new Error("Handoff 类型必须提供 expires（YYYY-MM-DD）");
	if (d.supersedes) {
		const rel = resolveRepoPath(d.supersedes).rel;
		if (!isFormalMemoryPath(rel)) throw new Error("supersedes 必须指向正式记忆文件");
	}
}

/** 由草案解析目标相对路径并做结构校验（最终仍以 memory 仓库脚本为准）。 */
export function resolveTargetPath(d: Draft): { path: string | null; error?: string } {
	try {
		validateDraft(d);
		const filename = filenameFromTitle(d.title);
		let rel: string;
		if (d.zone === "personal") {
			const layer = d.layer ?? "";
			if (!PERSONAL_TYPES[layer]) {
				return { path: null, error: `个人区 layer 必须是 ${Object.keys(PERSONAL_TYPES).join("/")}` };
			}
			if (!PERSONAL_TYPES[layer].includes(d.type)) {
				return { path: null, error: `${layer}/ 的 type 须为 ${PERSONAL_TYPES[layer].join("/")}` };
			}
			if (d.category && !(PERSONAL_SUBDIRS[layer] ?? []).includes(d.category)) {
				return { path: null, error: `${layer}/ 不允许二级目录 ${d.category}` };
			}
			rel = d.category ? `${layer}/${d.category}/${filename}.md` : `${layer}/${filename}.md`;
		} else {
			const project = d.project?.trim() ?? "";
			if (!project || !/^[\w\u4e00-\u9fff.-]+$/.test(project) || project === "." || project === ".." || /[. ]$/.test(project) ||
				/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(project)) {
				return { path: null, error: "项目区必须提供跨平台合法的 project 名" };
			}
			if (d.category) {
				if (!PROJECT_TYPES[d.category]) {
					return { path: null, error: `项目区 category 必须是 ${Object.keys(PROJECT_TYPES).join("/")}` };
				}
				if (!PROJECT_TYPES[d.category].includes(d.type)) {
					return { path: null, error: `${d.category}/ 的 type 须为 ${PROJECT_TYPES[d.category].join("/")}` };
				}
				rel = `projects/${project}/${d.category}/${filename}.md`;
			} else {
				if (!PROJECT_TYPE_NAMES.includes(d.type)) {
					return { path: null, error: `项目区 type 须为 ${PROJECT_TYPE_NAMES.join("/")}` };
				}
				rel = `projects/${project}/${filename}.md`;
			}
		}
		return { path: resolveRepoPath(rel).rel };
	} catch (err) {
		return { path: null, error: (err as Error).message };
	}
}

/** 生成正式记忆文件全文。 */
export function buildFile(d: Draft): string {
	validateDraft(d);
	const lines = [
		"---",
		`type: ${d.type}`,
		`title: ${scalar(d.title.trim())}`,
		`description: ${scalar(d.description.trim())}`,
		"status: active",
		"privacy: internal",
		`tags: [${d.tags.map((tag) => scalar(tag.trim())).join(", ")}]`,
		`timestamp: ${d.timestamp ?? today()}`,
	];
	if (d.zone === "project") lines.push("scope: project");
	if (d.expires) lines.push(`expires: ${d.expires}`);
	if (d.supersedes) lines.push(`supersedes: ${resolveRepoPath(d.supersedes).rel}`);
	lines.push("source: user-confirmed", "reviewed: true", "---", "", d.body.trim(), "");
	return lines.join("\n");
}

function buildPendingFile(d: Draft, target: string): string {
	const formal = buildFile(d)
		.replace(/^status: active$/m, "status: pending")
		.replace(/^source: user-confirmed$/m, "source: user-explicit")
		.replace(/^reviewed: true$/m, "reviewed: false");
	return formal.replace(/^---\n/, `---\ntarget: ${target}\n`);
}

function pendingToFormal(text: string): string {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---([\s\S]*)$/);
	if (!match) throw new Error("pending 文件缺少合法 frontmatter");
	const frontmatter = match[1]
		.split(/\r?\n/)
		.filter((line) => !/^target:\s*/.test(line))
		.map((line) => {
			if (/^status:\s*/.test(line)) return "status: active";
			if (/^source:\s*/.test(line)) return "source: user-confirmed";
			if (/^reviewed:\s*/.test(line)) return "reviewed: true";
			return line;
		})
		.join("\n");
	return `---\n${frontmatter}\n---${match[2]}`;
}

/** 极简 frontmatter 解析（仅用于受控 pending 文件与展示）。 */
export function parseSimpleFrontmatter(text: string): Record<string, string> {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return {};
	const out: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const i = line.indexOf(":");
		if (i <= 0) continue;
		const key = line.slice(0, i).trim();
		let value = line.slice(i + 1).trim();
		if (value.startsWith('"') && value.endsWith('"')) {
			try {
				value = JSON.parse(value);
			} catch {
				// 保留原值，后续仓库校验会拒绝非法格式。
			}
		}
		out[key] = String(value);
	}
	return out;
}

export function parseMemoryArgs(args: string): { cmd: string; rest: string[] } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	return { cmd: parts[0] ?? "status", rest: parts.slice(1) };
}

function pendingDir(): string {
	return resolveRepoPath("pending").abs;
}

export function listPendingIds(): string[] {
	if (!existsSync(pendingDir())) return [];
	return readdirSync(pendingDir())
		.filter((file) => file.endsWith(".md") && file !== "README.md")
		.map((file) => file.replace(/\.md$/, ""))
		.sort();
}

function pendingFile(id: string): string {
	if (!id || /[/\\\0]/.test(id) || id === "." || id === "..") throw new Error("pending id 无效");
	return resolveRepoPath(`pending/${id.replace(/\.md$/, "")}.md`).abs;
}

async function scanCandidate(pi: ExtensionAPI, content: string): Promise<string | null> {
	const temp = mkdtempSync(join(tmpdir(), "memark-candidate-"));
	try {
		writeFileSync(join(temp, "candidate.md"), content);
		const result = await runRepoScript(pi, "secret_scan.py", [temp], { timeout: WRITE_TIMEOUT_MS });
		return result.code === 0 ? null : (result.stderr || result.stdout).trim();
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

async function savePending(pi: ExtensionAPI, draft: Draft, target: string): Promise<string> {
	return withRepoMutation(async () => {
		const content = buildPendingFile(draft, target);
		const secretError = await scanCandidate(pi, content);
		if (secretError) throw new Error(`候选含疑似敏感信息，未保存：\n${secretError}`);
		mkdirSync(pendingDir(), { recursive: true });
		const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
		const shortName = basename(target, ".md").slice(0, 60);
		const id = `${stamp}-${shortName}-${randomUUID().slice(0, 6)}`;
		const file = pendingFile(id);
		await withFileMutationQueue(file, async () => writeFileSync(file, content, { flag: "wx", mode: 0o600 }));
		return `已保存为待审核候选 pending/${id}.md（目标 ${target}），未提交。` +
			"可用 /memory review 查看、/memory approve <id> 批准或 /memory reject <id> 原因 拒绝。";
	});
}

async function runReadOnlyChecks(pi: ExtensionAPI, root = REPO): Promise<string | null> {
	const checks: Array<[string, string[]]> = [
		["generate_index.py", ["--check", "--root", root]],
		["validate.py", ["--root", root]],
		["secret_scan.py", [root]],
	];
	const failures: string[] = [];
	for (const [script, args] of checks) {
		const result = await runRepoScript(pi, script, args, { timeout: WRITE_TIMEOUT_MS });
		if (result.code !== 0) failures.push((result.stderr || result.stdout).trim());
	}
	return failures.length ? failures.join("\n") : null;
}

async function trackedFiles(pi: ExtensionAPI): Promise<string[]> {
	const result = await git(pi, ["ls-files", "-z"]);
	if (result.code !== 0) throw new Error(`无法读取 git 文件清单：${(result.stderr || result.stdout).trim()}`);
	return result.stdout.split("\0").filter(Boolean).map((path) => path.replace(/\\/g, "/"));
}

function projectReadme(name: string): string {
	return `# ${name} 项目记忆\n\n` +
		"本目录保存仅在该项目内有效的长期记忆。\n\n" +
		"- `decisions/`：架构决策及理由（Decision）\n" +
		"- `topics/`：已验证的项目知识（Topic）\n" +
		"- `incidents/`：可复用的事故教训（Incident）\n" +
		"- `handoffs/`：未完成工作的交接（Handoff，须设置 expires）\n\n" +
		"准入：单项目有效即可，仍须用户批准与敏感信息检查；每轮硬规则留在项目 AGENTS.md。\n";
}

function addProjectScaffolds(changes: Changes): void {
	for (const [rel, content] of [...changes]) {
		if (content === null) continue;
		const parts = rel.split("/");
		if (parts[0] !== "projects" || parts.length < 3) continue;
		const readme = `projects/${parts[1]}/README.md`;
		if (!existsSync(resolveRepoPath(readme).abs) && !changes.has(readme)) {
			changes.set(readme, projectReadme(parts[1]));
		}
	}
}

function listIndexPaths(root: string): string[] {
	const paths = ["INDEX.md"];
	const projects = join(root, PROJECTS_DIR);
	if (!existsSync(projects)) return paths;
	for (const entry of readdirSync(projects, { withFileTypes: true })) {
		if (entry.isDirectory()) paths.push(`projects/${entry.name}/INDEX.md`);
	}
	return paths;
}

function applyChanges(root: string, changes: Changes): void {
	for (const [rel, content] of changes) {
		const abs = join(root, ...rel.split("/"));
		if (content === null) {
			rmSync(abs, { force: true });
			continue;
		}
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, content);
	}
}

async function prepareChanges(pi: ExtensionAPI, requested: Changes): Promise<Changes> {
	const changes = new Map(requested);
	addProjectScaffolds(changes);
	const temp = mkdtempSync(join(tmpdir(), "memark-preflight-"));
	try {
		for (const rel of await trackedFiles(pi)) {
			const source = resolveRepoPath(rel).abs;
			if (!existsSync(source)) continue;
			if (lstatSync(source).isSymbolicLink()) throw new Error(`仓库含不允许的符号链接：${rel}`);
			const dest = join(temp, ...rel.split("/"));
			mkdirSync(dirname(dest), { recursive: true });
			writeFileSync(dest, readFileSync(source));
		}
		applyChanges(temp, changes);

		const generated = await runRepoScript(pi, "generate_index.py", ["--root", temp], { timeout: WRITE_TIMEOUT_MS });
		if (generated.code !== 0) throw new Error((generated.stderr || generated.stdout).trim());
		const validation = await runRepoScript(pi, "validate.py", ["--root", temp], { timeout: WRITE_TIMEOUT_MS });
		if (validation.code !== 0) throw new Error((validation.stderr || validation.stdout).trim());
		const secrets = await runRepoScript(pi, "secret_scan.py", [temp], { timeout: WRITE_TIMEOUT_MS });
		if (secrets.code !== 0) throw new Error((secrets.stderr || secrets.stdout).trim());

		for (const rel of listIndexPaths(temp)) {
			const tempPath = join(temp, ...rel.split("/"));
			if (!existsSync(tempPath)) continue;
			const next = readFileSync(tempPath, "utf8");
			const currentPath = resolveRepoPath(rel).abs;
			const current = existsSync(currentPath) ? readFileSync(currentPath, "utf8") : null;
			if (current !== next) changes.set(rel, next);
		}
		return changes;
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

function conciseDiff(before: string | null, after: string | null): string {
	if (before === null && after !== null) return after.split("\n").map((line) => `+ ${line}`).join("\n");
	if (before !== null && after === null) return before.split("\n").map((line) => `- ${line}`).join("\n");
	const oldLines = (before ?? "").split("\n");
	const newLines = (after ?? "").split("\n");
	const oldCount = new Map<string, number>();
	const newCount = new Map<string, number>();
	for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
	for (const line of newLines) newCount.set(line, (newCount.get(line) ?? 0) + 1);
	const removed = oldLines.filter((line) => (newCount.get(line) ?? 0) < (oldCount.get(line) ?? 0));
	const added = newLines.filter((line) => (oldCount.get(line) ?? 0) < (newCount.get(line) ?? 0));
	return [...removed.map((line) => `- ${line}`), ...added.map((line) => `+ ${line}`)].join("\n") || "（内容顺序发生变化）";
}

function changePreview(changes: Changes): string {
	const sections: string[] = [];
	for (const [rel, after] of changes) {
		const abs = resolveRepoPath(rel).abs;
		const before = existsSync(abs) ? readFileSync(abs, "utf8") : null;
		sections.push(`### ${rel}\n${conciseDiff(before, after)}`);
	}
	let preview = sections.join("\n\n");
	if (preview.length > 30_000) preview = `${preview.slice(0, 30_000)}\n…[预览过长，已截断]`;
	return preview;
}

async function rollbackExact(pi: ExtensionAPI, snapshots: ReturnType<typeof snapshotFiles>): Promise<void> {
	const paths = snapshots.map((snapshot) => snapshot.rel);
	await git(pi, ["reset", "--quiet", "HEAD", "--", ...paths]);
	restoreSnapshots(snapshots);
}

async function changedPathSet(pi: ExtensionAPI): Promise<Set<string>> {
	return new Set((await worktreeChanges(pi)).map((change) => change.path));
}

/** 与 pi 内置 edit/write 共用逐文件队列；路径排序避免多文件操作互相等待。 */
async function withFileQueues<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
	const absolute = [...new Set(paths.map((rel) => resolveRepoPath(rel).abs))].sort();
	const enter = (index: number): Promise<T> =>
		index >= absolute.length
			? fn()
			: withFileMutationQueue(absolute[index], () => enter(index + 1));
	return enter(0);
}

async function commitPreparedChanges(
	pi: ExtensionAPI,
	ctx: Ctx,
	requested: Changes,
	baseHead: string,
	confirmTitle: string,
	commitSubject: string,
): Promise<WriteResult> {
	let prepared: Changes;
	try {
		prepared = await prepareChanges(pi, requested);
	} catch (err) {
		return { success: false, text: `✗ 草案校验未通过，正式仓库未改动：\n${(err as Error).message}` };
	}

	const approved = ctx.hasUI ? await ctx.ui.confirm(confirmTitle, changePreview(prepared)) : false;
	if (!approved) return { success: false, text: "已取消，正式仓库未改动。" };

	// 用户确认期间远端可能变化；再次同步。若 HEAD 改变，不使用旧预览继续提交。
	const pull = await git(pi, ["pull", "--ff-only", "--quiet"], { timeout: WRITE_TIMEOUT_MS });
	if (pull.code !== 0) {
		return {
			success: false,
			deferred: true,
			text: `远端同步失败，未写入正式记忆：${(pull.stderr || pull.stdout).trim()}`,
		};
	}
	const nowHead = (await git(pi, ["rev-parse", "HEAD"])).stdout.trim();
	if (nowHead !== baseHead) {
		return {
			success: false,
			deferred: true,
			text: "用户确认期间远端记忆发生变化。为避免覆盖，已停止；候选保留待重新审核。",
		};
	}
	const dirty = await unsafeWorktreeChanges(pi);
	if (dirty.length > 0) {
		return {
			success: false,
			deferred: true,
			text: `记忆仓库出现未提交修改，已停止：${dirty.map((item) => item.path).join(", ")}`,
		};
	}

	const paths = [...prepared.keys()];
	return withFileQueues(paths, async () => {
		const snapshots = snapshotFiles(paths);
		let committed = false;
		try {
			applyChanges(REPO, prepared);
			const checkError = await runReadOnlyChecks(pi);
			if (checkError) throw new Error(checkError);

			const actual = await changedPathSet(pi);
			const allowed = new Set(paths);
			const unexpected = [...actual].filter((path) => !allowed.has(path) && !path.startsWith("pending/"));
			if (unexpected.length > 0) throw new Error(`出现计划外修改：${unexpected.join(", ")}`);

			await git(pi, ["add", "-A", "--", ...paths]);
			const stagedResult = await git(pi, ["diff", "--cached", "--name-only", "-z"]);
			const staged = stagedResult.stdout.split("\0").filter(Boolean).map((path) => path.replace(/\\/g, "/"));
			const stagedUnexpected = staged.filter((path) => !allowed.has(path));
			if (stagedUnexpected.length > 0) throw new Error(`暂存区含计划外文件：${stagedUnexpected.join(", ")}`);
			if (staged.length === 0) throw new Error("没有可提交的修改");

			const commit = await git(pi, ["commit", "-m", commitSubject], { timeout: WRITE_TIMEOUT_MS });
			if (commit.code !== 0) throw new Error(`git commit 失败：${(commit.stderr || commit.stdout).trim()}`);
			committed = true;
		} catch (err) {
			if (!committed) await rollbackExact(pi, snapshots);
			return { success: false, text: `✗ 写入失败，已精确恢复本次涉及的文件：\n${(err as Error).message}` };
		}

		const push = await git(pi, ["push"], { timeout: WRITE_TIMEOUT_MS });
		const hash = (await git(pi, ["rev-parse", "--short", "HEAD"])).stdout.trim();
		return push.code === 0
			? { success: true, text: `✓ 已写入并推送（${hash}）` }
			: {
				success: true,
				text: `✓ 已在本地提交（${hash}）\n⚠ 上传失败，正式内容仍安全保存在本地：${(push.stderr || push.stdout).trim()}`,
			};
	});
}

async function prepareWritableRepo(pi: ExtensionAPI): Promise<{ head?: string; result?: WriteResult }> {
	if (!existsSync(join(REPO, ".git"))) {
		return { result: { success: false, text: `✗ 记忆仓库不存在或不是 git 仓库：${REPO}` } };
	}
	const dirty = await unsafeWorktreeChanges(pi);
	if (dirty.length > 0) {
		return {
			result: {
				success: false,
				deferred: true,
				text: `记忆仓库有尚未处理的修改，自动写入已停止：${dirty.map((item) => item.path).join(", ")}`,
			},
		};
	}
	const pull = await git(pi, ["pull", "--ff-only", "--quiet"], { timeout: WRITE_TIMEOUT_MS });
	if (pull.code !== 0) {
		return {
			result: {
				success: false,
				deferred: true,
				text: `无法下载远端最新记忆，正式写入已停止：${(pull.stderr || pull.stdout).trim()}`,
			},
		};
	}
	const checkError = await runReadOnlyChecks(pi);
	if (checkError) return { result: { success: false, text: `✗ 当前记忆仓库校验失败，请先修复：\n${checkError}` } };
	return { head: (await git(pi, ["rev-parse", "HEAD"])).stdout.trim() };
}

async function writeFormal(
	pi: ExtensionAPI,
	ctx: Ctx,
	relInput: string,
	content: string,
	commitNote = "",
): Promise<WriteResult> {
	return withRepoMutation(async () => {
		const rel = resolveRepoPath(relInput).rel;
		if (!isFormalMemoryPath(rel)) return { success: false, text: `✗ 目标不是合法的正式记忆路径：${rel}` };
		const ready = await prepareWritableRepo(pi);
		if (ready.result) return ready.result;
		if (existsSync(resolveRepoPath(rel).abs)) return { success: false, text: `✗ 目标文件已存在：${rel}` };

		const changes: Changes = new Map([[rel, content]]);
		const supersedes = parseSimpleFrontmatter(content).supersedes;
		if (supersedes) {
			const oldRel = resolveRepoPath(supersedes).rel;
			if (!isFormalMemoryPath(oldRel)) return { success: false, text: "✗ supersedes 不是正式记忆路径" };
			const oldPath = resolveRepoPath(oldRel).abs;
			if (!existsSync(oldPath)) return { success: false, text: `✗ supersedes 目标不存在：${oldRel}` };
			const oldText = readFileSync(oldPath, "utf8");
			if (!/^status: active$/m.test(oldText)) return { success: false, text: `✗ 只能取代 active 记忆：${oldRel}` };
			changes.set(oldRel, oldText.replace(/^status: active$/m, "status: superseded"));
		}
		const subject = `memory: ${rel}${commitNote ? ` (${commitNote})` : ""}`;
		const result = await commitPreparedChanges(pi, ctx, changes, ready.head!, "memark：确认以下修改？", subject);
		if (result.success) result.text = `${result.text}\n${rel}`;
		return result;
	});
}

export function registerCurator(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "memark_remember",
		label: "Memory Remember",
		description:
			"将一条用户明确要求记住的内容写入记忆仓库：先在临时副本校验并展示修改预览，用户确认后才写入正式目录、精确提交并推送。" +
			"无 UI、离线或仓库存在未处理修改时，只保存到本机 pending/ 待审核区。" +
			"个人区 zone=personal；项目区 zone=project，Handoff 必须设置 expires。仅在用户明确要求记住时调用。",
		promptSnippet: "Write an explicitly requested memory through memark's reviewed draft flow",
		promptGuidelines: [
			"Use memark_remember only when the user explicitly asks to remember something; formal storage always requires a displayed preview and user confirmation.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "一句话标题（单行、可区分）" }),
			description: Type.String({ description: "单行说明：内容是什么、何时调用" }),
			body: Type.String({ description: "记忆正文：最小、可执行，不含敏感信息" }),
			tags: Type.Array(Type.String(), { minItems: 1, description: "跨目录主题标签" }),
			zone: StringEnum(["personal", "project"] as const),
			layer: Type.Optional(StringEnum(["identity", "principles", "preferences", "context", "knowledge"] as const)),
			category: Type.Optional(Type.String({ description: "二级分类（可选）" })),
			project: Type.Optional(Type.String({ description: "项目名（zone=project 必填）" })),
			type: StringEnum(ALL_TYPES),
			expires: Type.Optional(Type.String({ description: "真实的 YYYY-MM-DD 日期（Handoff 必填）" })),
			supersedes: Type.Optional(Type.String({ description: "被取代记忆的仓库相对路径" })),
			as_pending: Type.Optional(Type.Boolean({ description: "只保存为本机待审核候选" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				if (signal?.aborted) throw new Error("操作已取消");
				const draft = params as unknown as Draft;
				const target = resolveTargetPath(draft);
				if (target.error || !target.path) throw new Error(target.error ?? "无法解析目标路径");
				const rel = target.path;
				if (existsSync(resolveRepoPath(rel).abs)) {
					throw new Error(`目标文件已存在：${rel}。如需替代旧记忆，请使用新标题并设置 supersedes。`);
				}
				if (draft.supersedes && resolveRepoPath(draft.supersedes).rel === rel) {
					throw new Error("新记忆不能用同一路径取代自身");
				}

				if (params.as_pending || !ctx?.hasUI) {
					const text = await savePending(pi, draft, rel);
					return { content: [{ type: "text", text }], details: {} };
				}

				const result = await writeFormal(pi, ctx as Ctx, rel, buildFile(draft));
				if (!result.success && result.deferred) {
					const pending = await savePending(pi, draft, rel);
					result.text = `${result.text}\n${pending}`;
				}
				return { content: [{ type: "text", text: result.text }], details: {} };
			} catch (err) {
				throw new Error(`memark_remember 失败：${(err as Error).message}`);
			}
		},
	});
}

async function syncRepository(pi: ExtensionAPI): Promise<WriteResult> {
	return withRepoMutation(async () => {
		const dirty = await unsafeWorktreeChanges(pi);
		if (dirty.length > 0) {
			return { success: false, text: `仓库有尚未处理的修改，拒绝自动同步：${dirty.map((item) => item.path).join(", ")}` };
		}
		const pull = await git(pi, ["pull", "--ff-only"], { timeout: 60_000 });
		if (pull.code !== 0) return { success: false, text: `下载失败：${(pull.stderr || pull.stdout).trim()}` };

		const indexCheck = await runRepoScript(pi, "generate_index.py", ["--check"], { timeout: WRITE_TIMEOUT_MS });
		if (indexCheck.code !== 0) {
			const possible = listIndexPaths(REPO);
			const repairError = await withFileQueues(possible, async () => {
				const snapshots = snapshotFiles(possible);
				try {
					const generate = await runRepoScript(pi, "generate_index.py", [], { timeout: WRITE_TIMEOUT_MS });
					if (generate.code !== 0) throw new Error((generate.stderr || generate.stdout).trim());
					const errors = await runReadOnlyChecks(pi);
					if (errors) throw new Error(errors);
					const changed = await unsafeWorktreeChanges(pi);
					const allowed = new Set(possible);
					const unexpected = changed.filter((item) => !allowed.has(item.path));
					if (unexpected.length > 0) {
						throw new Error(`索引修复出现计划外文件：${unexpected.map((item) => item.path).join(", ")}`);
					}
					const paths = [...new Set(changed.map((item) => item.path))];
					if (paths.length > 0) {
						await git(pi, ["add", "-A", "--", ...paths]);
						const commit = await git(pi, ["commit", "-m", "chore: rebuild index after sync"]);
						if (commit.code !== 0) throw new Error((commit.stderr || commit.stdout).trim());
					}
					return null;
				} catch (err) {
					await rollbackExact(pi, snapshots);
					return (err as Error).message;
				}
			});
			if (repairError) return { success: false, text: `索引修复失败，已恢复：${repairError}` };
		} else {
			const errors = await runReadOnlyChecks(pi);
			if (errors) return { success: false, text: `仓库检查失败：\n${errors}` };
		}

		const push = await git(pi, ["push"], { timeout: 60_000 });
		const head = (await git(pi, ["rev-parse", "--short", "HEAD"])).stdout.trim();
		return push.code === 0
			? { success: true, text: `已同步到 ${head}` }
			: { success: false, text: `本地已更新到 ${head}，但上传失败：${(push.stderr || push.stdout).trim()}` };
	});
}

function expiredMemories(): string[] {
	const todayValue = today();
	const indexes = [readIndex()];
	const projectsRoot = join(REPO, PROJECTS_DIR);
	if (existsSync(projectsRoot)) {
		for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
			if (entry.isDirectory()) indexes.push(readIndex(join(projectsRoot, entry.name)));
		}
	}
	const expired: string[] = [];
	for (const line of indexes.flat()) {
		const match = line.match(/—\s*(\S+\.md)\s*$/);
		if (!match) continue;
		try {
			const text = readFileSync(resolveRepoPath(match[1]).abs, "utf8");
			const expiry = text.match(/^expires:\s*(\d{4}-\d{2}-\d{2})$/m)?.[1];
			if (expiry && expiry < todayValue) expired.push(match[1]);
		} catch {
			// maintain 会由仓库校验报告缺失文件。
		}
	}
	return expired;
}

/** /memory 命令族入口。 */
export async function handleMemoryCommand(pi: ExtensionAPI, args: string, ctx: Ctx): Promise<void> {
	const { cmd, rest } = parseMemoryArgs(args);
	const notify = (message: string, tone: "info" | "warning" | "error" = "info") => ctx.ui.notify(message, tone);

	if (cmd === "status") {
		if (!existsSync(REPO)) {
			notify(`memark：记忆仓库不存在（${REPO}）。`, "warning");
			return;
		}
		const entries = readIndex().filter((line) => line.includes(".md")).length;
		const pending = countMd(join(REPO, "pending"));
		const counts = LAYERS.map((layer) => `${layer}: ${countMd(join(REPO, layer))}`).join("  ");
		let projectInfo = "无";
		const projectsRoot = join(REPO, PROJECTS_DIR);
		if (existsSync(projectsRoot)) {
			const names = readdirSync(projectsRoot, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort();
			if (names.length > 0) projectInfo = names.map((name) => `${name}: ${countMd(join(projectsRoot, name))}`).join("  ");
		}
		const changes = await worktreeChanges(pi);
		const branch = (await git(pi, ["branch", "--show-current"])).stdout.trim() || "?";
		const divergence = await git(pi, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
		const syncInfo = divergence.code === 0 ? divergence.stdout.trim().split(/\s+/) : [];
		const relation = syncInfo.length === 2 ? `，超前 ${syncInfo[0]} / 落后 ${syncInfo[1]}` : "";
		notify(
			`memark @ ${REPO}\n个人区索引条目: ${entries}  待审核: ${pending}  git: ${branch}` +
			`${changes.length ? `（${changes.length} 处未处理）` : "（干净）"}${relation}\n${counts}\n项目区: ${projectInfo}\n` +
			"第一次查找记忆时会尝试下载最新版本；完整同步用 /memory sync。",
			"info",
		);
		return;
	}

	if (cmd === "review") {
		const ids = listPendingIds();
		if (ids.length === 0) {
			notify("待审核区为空。", "info");
			return;
		}
		const lines = ids.map((id) => {
			const fm = parseSimpleFrontmatter(readFileSync(pendingFile(id), "utf8"));
			return `${id}  →  ${fm.target ?? "?"}  ｜ ${fm.title ?? "?"}`;
		});
		notify(`待审核候选（${ids.length} 条）：\n${lines.join("\n")}\n批准：/memory approve <id>；拒绝：/memory reject <id> 原因`, "info");
		return;
	}

	if (cmd === "approve" || cmd === "reject") {
		const id = rest[0]?.replace(/\.md$/, "");
		if (!id) {
			notify(`用法：/memory ${cmd} <id>`, "warning");
			return;
		}
		let file: string;
		try {
			file = pendingFile(id);
		} catch (err) {
			notify((err as Error).message, "error");
			return;
		}
		if (!existsSync(file)) {
			notify(`pending/${id}.md 不存在。`, "error");
			return;
		}
		if (cmd === "reject") {
			const reason = rest.slice(1).join(" ") || "未填写原因";
			await withFileMutationQueue(file, async () => rmSync(file));
			try {
				pi.appendEntry("memark-rejection", { candidateId: id, reason, rejectedAt: new Date().toISOString() });
			} catch {
				// 审计记录失败不能阻止用户拒绝候选；不保存候选原文。
			}
			notify(`已拒绝并删除 pending/${id}.md（${reason}）`, "info");
			return;
		}

		const text = readFileSync(file, "utf8");
		const fm = parseSimpleFrontmatter(text);
		if (!fm.target) {
			notify(`pending/${id}.md 缺少 target 字段。`, "error");
			return;
		}
		let result: WriteResult;
		try {
			result = await writeFormal(pi, ctx, fm.target, pendingToFormal(text), id);
		} catch (err) {
			notify(`批准失败：${(err as Error).message}`, "error");
			return;
		}
		if (result.success) await withFileMutationQueue(file, async () => rmSync(file));
		notify(result.text, result.success ? "info" : result.deferred ? "warning" : "error");
		return;
	}

	if (cmd === "forget") {
		const input = rest[0];
		if (!input) {
			notify("用法：/memory forget <正式记忆相对路径>", "warning");
			return;
		}
		let result: WriteResult;
		try {
			result = await withRepoMutation(async () => {
				const rel = resolveRepoPath(input).rel;
				if (!isFormalMemoryPath(rel)) return { success: false, text: `拒绝归档非正式记忆路径：${rel}` };
				const ready = await prepareWritableRepo(pi);
				if (ready.result) return ready.result;
				const source = resolveRepoPath(rel).abs;
				if (!existsSync(source)) return { success: false, text: `文件不存在：${rel}` };
				const original = readFileSync(source, "utf8");
				if (!/^status: active$/m.test(original)) return { success: false, text: "只能归档 status: active 的记忆" };
				const destination = resolveRepoPath(`archive/${rel}`).rel;
				if (existsSync(resolveRepoPath(destination).abs)) return { success: false, text: `归档目标已存在：${destination}` };
				const changes: Changes = new Map([
					[rel, null],
					[destination, original.replace(/^status: active$/m, "status: archived")],
				]);
				return commitPreparedChanges(pi, ctx, changes, ready.head!, "memark：确认归档以下记忆？", `memory: archive ${rel}`);
			});
		} catch (err) {
			result = { success: false, text: `归档失败：${(err as Error).message}` };
		}
		notify(result.text, result.success ? "info" : "error");
		return;
	}

	if (cmd === "sync") {
		try {
			const result = await syncRepository(pi);
			notify(result.text, result.success ? "info" : "error");
		} catch (err) {
			notify(`同步失败：${(err as Error).message}`, "error");
		}
		return;
	}

	if (cmd === "maintain") {
		const errors = await runReadOnlyChecks(pi);
		const expired = expiredMemories();
		if (errors) {
			notify(`维护检查未通过：\n${errors}`, "error");
		} else {
			notify(`维护检查通过。${expired.length ? `\n已过期、应复核：\n${expired.join("\n")}` : "没有发现已过期记忆。"}`, expired.length ? "warning" : "info");
		}
		return;
	}

	if (cmd === "revert") {
		try {
			await withRepoMutation(async () => {
				const dirty = await unsafeWorktreeChanges(pi);
				if (dirty.length > 0) {
					notify(`仓库有尚未处理的修改，拒绝撤销：${dirty.map((item) => item.path).join(", ")}`, "error");
					return;
				}
				const pull = await git(pi, ["pull", "--ff-only", "--quiet"], { timeout: WRITE_TIMEOUT_MS });
				if (pull.code !== 0) {
					notify(`同步失败，拒绝撤销：${(pull.stderr || pull.stdout).trim()}`, "error");
					return;
				}
				const baseHead = (await git(pi, ["rev-parse", "HEAD"])).stdout.trim();
				const logResult = await git(pi, ["log", "-100", "--pretty=format:%H%x1f%s%x1f%b%x1e"]);
				const reverted = new Set<string>();
				let target: { hash: string; subject: string } | null = null;
				let blocked: string | null = null;
				for (const record of logResult.stdout.split("\x1e")) {
					const [hash, subject, body = ""] = record.trim().split("\x1f");
					if (!hash || !subject) continue;
					const revertedHash = body.match(/This reverts commit ([0-9a-f]{40})\./)?.[1];
					if (subject.startsWith("Revert ") && revertedHash) {
						reverted.add(revertedHash);
						continue;
					}
					if (subject === "chore: rebuild index after sync") continue;
					if (!subject.startsWith("memory:")) {
						blocked = subject;
						break;
					}
					if (!reverted.has(hash)) {
						target = { hash, subject };
						break;
					}
				}
				if (!target) {
					notify(blocked ? `最近存在非记忆提交（${blocked}），拒绝跨越它自动撤销。` : "没有可安全撤销的记忆提交。", "warning");
					return;
				}
				const stat = (await git(pi, ["show", "--stat", "--oneline", "--no-renames", target.hash])).stdout.trim();
				const ok = ctx.hasUI ? await ctx.ui.confirm("memark：确认撤销这次记忆修改？", stat) : false;
				if (!ok) {
					notify("已取消。", "info");
					return;
				}
				const confirmPull = await git(pi, ["pull", "--ff-only", "--quiet"], { timeout: WRITE_TIMEOUT_MS });
				if (confirmPull.code !== 0) {
					notify(`确认期间同步失败，已停止撤销：${(confirmPull.stderr || confirmPull.stdout).trim()}`, "error");
					return;
				}
				const confirmedHead = (await git(pi, ["rev-parse", "HEAD"])).stdout.trim();
				if (confirmedHead !== baseHead) {
					notify("确认期间远端记忆发生变化，已停止撤销；请重新执行 /memory revert。", "warning");
					return;
				}
				const pathResult = await git(pi, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", target.hash]);
				if (pathResult.code !== 0) {
					notify(`无法读取待撤销文件清单：${(pathResult.stderr || pathResult.stdout).trim()}`, "error");
					return;
				}
				const paths = pathResult.stdout.split("\0").filter(Boolean).map((path) => path.replace(/\\/g, "/"));
				await withFileQueues(paths, async () => {
					const lateDirty = await unsafeWorktreeChanges(pi);
					if (lateDirty.length > 0) {
						notify(`确认期间仓库出现修改，已停止撤销：${lateDirty.map((item) => item.path).join(", ")}`, "error");
						return;
					}
					const revert = await git(pi, ["revert", "--no-edit", target.hash], { timeout: WRITE_TIMEOUT_MS });
					if (revert.code !== 0) {
						await git(pi, ["revert", "--abort"]);
						notify(`撤销失败，已清理中间状态：${(revert.stderr || revert.stdout).trim()}`, "error");
						return;
					}
					const push = await git(pi, ["push"], { timeout: WRITE_TIMEOUT_MS });
					notify(`✓ 已撤销：${target.subject}${push.code === 0 ? "，并已上传" : "；上传失败，撤销记录保留在本地"}`, push.code === 0 ? "info" : "warning");
				});
			});
		} catch (err) {
			notify(`撤销失败：${(err as Error).message}`, "error");
		}
		return;
	}

	notify(`未知子命令：${cmd}。可用：status / sync / review / approve / reject / maintain / forget / revert`, "warning");
}
