/**
 * memark curator —— 受控记忆写入。
 *
 * 核心边界：先在临时副本校验并展示修改预览；用户确认后才触碰正式目录。
 * 所有写入按仓库串行，使用安全相对路径、精确暂存和精确回滚。
 */
import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	rmdirSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { runtime } from "./diagnostics";
import { showReview, type ReviewContext } from "./review-ui";
import { parseMetadata, parseSimpleFrontmatter, rewriteMemory, validDate } from "./metadata";
export { parseSimpleFrontmatter } from "./metadata";
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
	snapshotsMatch,
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
const ALL_TYPES = ["Identity", "Principle", "Preference", "Context", "Skill", "Experience", "Learning", "Decision", "Topic", "Incident", "Handoff"] as const;
const PROJECT_TYPE_NAMES = ["Decision", "Topic", "Incident", "Handoff"];
const PROJECT_CATEGORY_BY_TYPE: Record<string, string> = {
	Decision: "decisions",
	Topic: "topics",
	Incident: "incidents",
	Handoff: "handoffs",
};
const PERSONAL_CATEGORY_BY_TYPE: Record<string, string> = {
	Skill: "skills",
	Experience: "experiences",
	Learning: "learnings",
};
const CATEGORY_ALIASES: Record<string, string> = {
	decision: "decisions",
	decisions: "decisions",
	topic: "topics",
	topics: "topics",
	incident: "incidents",
	incidents: "incidents",
	handoff: "handoffs",
	handoffs: "handoffs",
	current: "current",
	relationship: "relationships",
	relationships: "relationships",
	skill: "skills",
	skills: "skills",
	experience: "experiences",
	experiences: "experiences",
	learning: "learnings",
	learnings: "learnings",
};
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
	edit?: string;
	timestamp?: string;
	as_pending?: boolean;
}

const REQUIRED_ARGUMENTS = ["title", "description", "body", "tags", "zone", "type"] as const;
const OPTIONAL_ARGUMENTS = ["layer", "category", "project", "expires", "supersedes", "edit", "as_pending"] as const;

function optionalNullable<T extends TSchema>(schema: T, description: string) {
	// Some request adapters require every property; null must remain a legal unused value.
	return Type.Optional(Type.Union([schema, Type.Null()], {
		description: `${description}；不适用时省略或传 null`,
	}));
}

interface Ctx extends ReviewContext {
	cwd?: string;
}

interface WriteResult {
	success: boolean;
	deferred?: boolean;
	candidate?: { rel: string; content: string };
	text: string;
}

type Changes = Map<string, string | null>;

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function scalar(value: string): string {
	return JSON.stringify(value);
}

/** 兼容旧 category 常见变体；不能把跨区或语义冲突猜成另一种记忆。 */
function normalizeCategory(value: string): string {
	const key = value.trim().toLocaleLowerCase();
	return CATEGORY_ALIASES[key] ?? value.trim();
}

/** 唯一分类来源是 zone + type。prepareArguments 与直接执行/路径解析共用此入口。 */
export function normalizeLocation(input: Draft): Draft {
	const d = { ...input };
	// Reject required nulls before Pi can coerce them into strings such as "null".
	for (const field of REQUIRED_ARGUMENTS) if (d[field] === null) throw new Error(`${field} 不能为 null`);
	for (const field of OPTIONAL_ARGUMENTS) if (d[field] === null) delete d[field];
	if (d.edit) {
		// 原地编辑采用原文件的归属；调用方的路由字段不参与改写。
		delete d.category;
		return d;
	}
	if (typeof d.category === "string") {
		d.category = normalizeCategory(d.category);
		if (!d.category) delete d.category;
	}
	if (!d.zone || !d.type) return d; // schema/validateDraft 报告缺失字段。
	let expected: string | undefined;
	if (d.zone === "project") {
		if (!PROJECT_TYPE_NAMES.includes(d.type)) throw new Error(`分类冲突：zone=project 的 type 只能是 ${PROJECT_TYPE_NAMES.join("/")}，收到 ${d.type}；不得为绕过校验自动改成个人区`);
		if (d.layer) throw new Error(`分类冲突：zone=project 不使用个人区 layer=${d.layer}；请删除 layer`);
		expected = PROJECT_CATEGORY_BY_TYPE[d.type];
	} else if (d.zone === "personal") {
		const layer = Object.keys(PERSONAL_TYPES).find((key) => PERSONAL_TYPES[key].includes(d.type!));
		if (!layer) throw new Error(`分类冲突：zone=personal 不支持 type=${d.type}`);
		if (d.project) throw new Error("分类冲突：个人区不使用 project；请先确定适用范围");
		if (d.layer && d.layer !== layer) throw new Error(`分类冲突：type=${d.type} 对应 layer=${layer}，收到 ${d.layer}`);
		d.layer = layer;
		expected = PERSONAL_CATEGORY_BY_TYPE[d.type];
	} else throw new Error("zone 必须是 personal 或 project");
	if (expected) {
		if (d.category && d.category !== expected) {
			throw new Error(`分类冲突：zone=${d.zone}, type=${d.type} 唯一对应 ${expected}，收到 category=${d.category}；请删除冗余 category（若接口要求必填则传 null），或核实 type。不会自动改变适用范围`);
		}
		delete d.category; // 旧调用仍可传匹配值，但规范参数不再携带重复选择。
	}
	return d;
}

function validateDraft(d: Draft): void {
	if (!(ALL_TYPES as readonly string[]).includes(d.type)) throw new Error("type 必须是合法的记忆类型");
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
		d = normalizeLocation(d);
		if (d.zone !== "personal" && d.zone !== "project") throw new Error("zone 必须是 personal 或 project");
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
			// knowledge 层省略 category 时按 type 自动归入标准子目录；其余层保持原行为。
			const category = d.category ?? (layer === "knowledge" ? PERSONAL_CATEGORY_BY_TYPE[d.type] : undefined);
			if (category && !(PERSONAL_SUBDIRS[layer] ?? []).includes(category)) {
				return {
					path: null,
					error: `${layer}/ 不允许二级目录 ${category}（context: current/relationships；knowledge: skills/experiences/learnings）`,
				};
			}
			rel = category ? `${layer}/${category}/${filename}.md` : `${layer}/${filename}.md`;
		} else {
			const project = d.project?.trim() ?? "";
			if (!project || !/^[\w\u4e00-\u9fff.-]+$/.test(project) || project === "." || project === ".." || /[. ]$/.test(project) ||
				/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(project)) {
				return { path: null, error: "项目区必须提供跨平台合法的 project 名" };
			}
			const category = PROJECT_CATEGORY_BY_TYPE[d.type];
			if (!category) return { path: null, error: `项目区 type 须为 ${PROJECT_TYPE_NAMES.join("/")}` };
			rel = `projects/${project}/${category}/${filename}.md`;
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

function buildPendingFile(d: Draft | string, target: string): string {
	const formal = typeof d === "string" ? d : buildFile(d);
	const match = formal.match(/^---\r?\n([\s\S]*?)\r?\n---([\s\S]*)$/);
	if (!match) throw new Error("候选缺少合法 frontmatter");
	const fields = match[1].split(/\r?\n/).filter((line) => !/^\s*(target|status|source|reviewed)\s*:/.test(line));
	return `---\ntarget: ${target}\n${fields.join("\n")}\nstatus: pending\nsource: user-explicit\nreviewed: false\n---${match[2]}`;
}

function pendingToFormal(text: string): string {
	return rewriteMemory(text, { target: null, status: "active", source: "user-confirmed", reviewed: "true" });
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

async function savePending(pi: ExtensionAPI, draft: Draft | string, target: string): Promise<string> {
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
			// 删除项目最后一组文件时也去掉空父目录；临时副本和正式仓库同样处理。
			for (let dir = dirname(abs); dir !== root; dir = dirname(dir)) {
				if (!existsSync(dir)) continue;
				if (readdirSync(dir).length > 0) break;
				rmdirSync(dir);
			}
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

/** 使用 Git 的完整 unified diff；不按字符数截断，也不丢失重复行/顺序变化。 */
async function changePreview(pi: ExtensionAPI, changes: Changes, snapshots: ReturnType<typeof snapshotFiles>): Promise<string> {
	const temp = mkdtempSync(join(tmpdir(), "memark-preview-"));
	try {
		const sections: string[] = [];
		for (const [rel, after] of changes) {
			const snapshot = snapshots.find((item) => item.rel === rel)!;
			const before = snapshot.existed ? snapshot.content!.toString("utf8") : null;
			writeFileSync(join(temp, "before"), before ?? "", { mode: 0o600 });
			writeFileSync(join(temp, "after"), after ?? "", { mode: 0o600 });
			const diff = await pi.exec("git", ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--text", "--", join(temp, "before"), join(temp, "after")], { timeout: WRITE_TIMEOUT_MS });
			if (diff.killed || (diff.code !== 0 && diff.code !== 1)) throw new Error(`无法生成完整预览：${diff.stderr || diff.stdout}`);
			const hunk = diff.stdout.indexOf("@@");
			sections.push(`### ${before === null ? "新增" : after === null ? "删除" : "修改"} ${rel}\n${hunk < 0 ? "（内容未变化）" : diff.stdout.slice(hunk)}`);
		}
		return sections.join("\n\n");
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

function changeSummary(changes: Changes, primary?: string): string {
	const paths = [...changes.keys()];
	const memories = paths.filter(isFormalMemoryPath).length;
	const rel = primary ?? paths.find(isFormalMemoryPath);
	const project = rel?.startsWith("projects/") ? rel.split("/")[1] : undefined;
	const isNew = project && !existsSync(resolveRepoPath(`projects/${project}/README.md`).abs);
	const scope = project ? `项目区：${project}${isNew ? "（新建项目，Yes 同时批准创建路由和索引）" : ""}` : "个人区 / 归档";
	return `${scope}；${memories} 个记忆文件 + ${paths.length - memories} 个辅助文件。${rel ? `\n目标：${rel}` : ""}`;
}

async function rollbackExact(pi: ExtensionAPI, snapshots: ReturnType<typeof snapshotFiles>): Promise<void> {
	const paths = snapshots.map((snapshot) => snapshot.rel);
	const reset = await git(pi, ["reset", "--quiet", "HEAD", "--", ...paths]);
	if (reset.code !== 0) throw new Error(`无法恢复暂存区，请人工处理：${reset.stderr || reset.stdout}`);
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

/** 可在确认阶段编辑的草案：rel 指向主要记忆文件，rebuild 把编辑后全文重新组装成变更集。 */
interface EditableDraft {
	rel: string;
	rebuild: (content: string, rel: string) => Promise<{ changes: Changes } | { error: string }>;
	canRelocate?: boolean;
}

async function commitPreparedChanges(
	pi: ExtensionAPI,
	ctx: Ctx,
	requested: Changes,
	baseHead: string,
	confirmTitle: string,
	commitSubject: string | (() => string),
	editable?: EditableDraft,
	pendingSource?: { rel: string; text: string },
): Promise<WriteResult> {
	let prepared: Changes;
	try {
		prepared = await prepareChanges(pi, requested);
	} catch (err) {
		return { success: false, text: `✗ 草案校验未通过，正式仓库未改动：\n${(err as Error).message}` };
	}

	const defer = (text: string): WriteResult => {
		const content = editable && prepared.get(editable.rel);
		return { success: false, deferred: true, text,
			...(editable && typeof content === "string" ? { candidate: { rel: editable.rel, content } } : {}) };
	};
	const editor = ctx.hasUI ? ctx.ui.editor : undefined;
	const canEdit = Boolean(editor && editable);
	let banner = "";
	let reviewedSnapshots: ReturnType<typeof snapshotFiles> = [];
	while (true) {
		if (ctx.signal?.aborted) return { success: false, text: "已取消，正式仓库未改动。" };
		let choice: string;
		try {
			reviewedSnapshots = snapshotFiles([...prepared.keys()]);
			choice = await showReview(ctx, {
				title: confirmTitle,
				summary: changeSummary(prepared, editable?.rel),
				text: banner + await changePreview(pi, prepared, reviewedSnapshots),
				canEdit,
			});
		} catch (err) {
			return defer(`无法完成安全审核，正式仓库未改动：${(err as Error).message}`);
		}
		if (choice === "Edit" && editable && editor) {
			const current = prepared.get(editable.rel);
			if (typeof current !== "string") return { success: false, text: "找不到草案，已停止。" };
			try {
				let next = { rel: editable.rel, content: current };
				const action = editable.canRelocate && ctx.ui.select
					? await ctx.ui.select("memark：编辑草案", ["修改措辞", "修改归属", "返回预览"], { signal: ctx.signal }) : "修改措辞";
				if (action === "修改归属") {
					const moved = await chooseLocation(ctx, current);
					if (!moved) continue;
					next = moved;
				} else if (action === "修改措辞") {
					const content = await editor("memark：编辑草案（保存后重新审核）", current);
					if (content === undefined || content === current) continue;
					next.content = content;
				} else continue;
				const rebuilt = await editable.rebuild(next.content, next.rel);
				if ("error" in rebuilt) throw new Error(rebuilt.error);
				const checked = await prepareChanges(pi, rebuilt.changes);
				prepared = checked;
				editable.rel = next.rel;
				banner = "";
			} catch (err) {
				banner = `⚠ 编辑未通过：${(err as Error).message}\n\n`;
			}
			continue;
		}
		if (choice !== "Yes" || ctx.signal?.aborted) return { success: false, text: "已取消，正式仓库未改动。" };
		break;
	}

	// 用户确认期间远端可能变化；再次同步。若 HEAD 改变，不使用旧预览继续提交。
	const pull = await git(pi, ["pull", "--ff-only", "--quiet"], { timeout: WRITE_TIMEOUT_MS });
	if (pull.code !== 0) {
		return defer(`远端同步失败，未写入正式记忆：${(pull.stderr || pull.stdout).trim()}`);
	}
	const nowHead = (await git(pi, ["rev-parse", "HEAD"])).stdout.trim();
	if (nowHead !== baseHead) {
		return defer("用户确认期间远端记忆发生变化。为避免覆盖，已停止；需要重新审核。");
	}
	const dirty = await unsafeWorktreeChanges(pi);
	if (dirty.length > 0) {
		return defer(`记忆仓库出现未提交修改，已停止：${dirty.map((item) => item.path).join(", ")}`);
	}

	const paths = [...prepared.keys()];
	return withFileQueues(pendingSource ? [...paths, pendingSource.rel] : paths, async () => {
		if (ctx.signal?.aborted) return { success: false, text: "已取消，正式仓库未改动。" };
		if (pendingSource && !pendingMatches(pendingSource)) return { success: false, text: "候选在审核期间已变化或被拒绝，已停止；请重新审核当前 pending。" };
		// 排队获取文件锁也可能等待其他 edit/write，故原来的锁前检查不能作为最终依据。
		const lockedHead = await git(pi, ["rev-parse", "HEAD"]);
		const lateDirty = await unsafeWorktreeChanges(pi);
		if (lockedHead.code !== 0 || lockedHead.stdout.trim() !== baseHead || lateDirty.length || !snapshotsMatch(reviewedSnapshots)) {
			return defer("取得文件锁后发现仓库或原文已变化，未覆盖；请重新审核。");
		}
		const snapshots = reviewedSnapshots;
		let committed = false;
		try {
			applyChanges(REPO, prepared);
			const checkError = await runReadOnlyChecks(pi);
			if (checkError) throw new Error(checkError);

			const actual = await changedPathSet(pi);
			const allowed = new Set(paths);
			const unexpected = [...actual].filter((path) => !allowed.has(path) && !path.startsWith("pending/"));
			if (unexpected.length > 0) throw new Error(`出现计划外修改：${unexpected.join(", ")}`);

			const added = await git(pi, ["add", "-A", "--", ...paths]);
			if (added.code !== 0) throw new Error(`暂存失败：${added.stderr || added.stdout}`);
			const stagedResult = await git(pi, ["diff", "--cached", "--name-only", "-z"]);
			if (stagedResult.code !== 0) throw new Error(`无法检查暂存区：${stagedResult.stderr || stagedResult.stdout}`);
			const staged = stagedResult.stdout.split("\0").filter(Boolean).map((path) => path.replace(/\\/g, "/"));
			const stagedUnexpected = staged.filter((path) => !allowed.has(path));
			if (stagedUnexpected.length > 0) throw new Error(`暂存区含计划外文件：${stagedUnexpected.join(", ")}`);
			if (staged.length === 0) throw new Error("没有可提交的修改");

			if (ctx.signal?.aborted) throw new Error("操作已取消");
			const commit = await git(pi, ["commit", "-m", typeof commitSubject === "function" ? commitSubject() : commitSubject], { timeout: WRITE_TIMEOUT_MS });
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

/** 组装写入变更集：新记忆文件 + supersedes 旧记忆状态翻转；返回错误文案表示组装失败。 */
async function buildWriteChanges(rel: string, content: string): Promise<Changes | string> {
	const changes: Changes = new Map([[rel, content]]);
	const supersedes = parseSimpleFrontmatter(content).supersedes;
	if (!supersedes) return changes;
	let oldRel: string;
	try {
		oldRel = resolveRepoPath(supersedes).rel;
	} catch (err) {
		return `✗ supersedes 路径无效：${(err as Error).message}`;
	}
	if (!isFormalMemoryPath(oldRel)) return "✗ supersedes 不是正式记忆路径";
	if (oldRel === rel) return "✗ 新记忆不能用同一路径取代自身";
	const oldPath = resolveRepoPath(oldRel).abs;
	if (!existsSync(oldPath)) return `✗ supersedes 目标不存在：${oldRel}`;
	const oldText = readFileSync(oldPath, "utf8");
	if (parseMetadata(oldText)?.status !== "active") return `✗ 只能取代 active 记忆：${oldRel}`;
	changes.set(oldRel, rewriteMemory(oldText, { status: "superseded" }));
	return changes;
}

/** 用户显式调整归属；跨区时必须重新选择类型，不替用户猜测。只返回草案。 */
async function chooseLocation(ctx: Ctx, content: string): Promise<{ rel: string; content: string } | undefined> {
	if (!ctx.ui.select) return undefined;
	const select = (title: string, options: string[]) => ctx.ui.select!(title, options, { signal: ctx.signal });
	const zoneChoice = await select("memark：适用范围", ["个人区（跨项目）", "项目区（仅单项目）"]);
	if (!zoneChoice) return undefined;
	const zone = zoneChoice === "个人区（跨项目）" ? "personal" : zoneChoice === "项目区（仅单项目）" ? "project" : undefined;
	if (!zone) return undefined;
	const fm = parseSimpleFrontmatter(content);
	let project: string | undefined;
	if (zone === "project") {
		const root = resolveRepoPath(PROJECTS_DIR).abs;
		const names = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() : [];
		for (let page = 0;;) {
			const visible = names.slice(page * 6, page * 6 + 6);
			const labels = visible.map((name) => `${name}（现有）`);
			const choice = await select("memark：选择项目", [...labels, "新建项目", ...(names.length > 6 ? ["下一组"] : []), "返回预览"]);
			const index = choice ? labels.indexOf(choice) : -1;
			if (index >= 0) { project = visible[index]; break; }
			if (choice === "下一组") { page = (page + 1) % Math.ceil(names.length / 6); continue; }
			if (choice !== "新建项目") return undefined;
			if (!ctx.ui.input) throw new Error("客户端不支持输入新项目名，请取消后重新提交候选");
			project = (await ctx.ui.input("memark：新项目名（最终 Yes 才创建）", undefined, { signal: ctx.signal }))?.trim();
			if (!project) return undefined;
			break;
		}
	}
	const allowed = zone === "project" ? PROJECT_TYPE_NAMES : Object.values(PERSONAL_TYPES).flat();
	// 同一区保留现有类型；跨区必须由用户选择语义类型。
	const type = allowed.includes(fm.type) ? fm.type : await select("memark：选择新范围下的记忆类型", allowed);
	if (!type || !allowed.includes(type)) return undefined;
	let category: string | undefined;
	if (type === "Context") {
		const choice = await select("memark：Context 分类", ["current", "relationships", "不分子目录"]);
		if (!choice) return undefined;
		if (choice === "current" || choice === "relationships") category = choice;
		else if (choice !== "不分子目录") return undefined;
	}
	let expires: string | undefined = fm.expires;
	if (type === "Handoff" && !expires) {
		if (!ctx.ui.input) throw new Error("Handoff 需要输入到期日期");
		expires = await ctx.ui.input("memark：Handoff 到期日期 YYYY-MM-DD", undefined, { signal: ctx.signal });
		if (!expires) return undefined;
	}
	const target = resolveTargetPath({ title: fm.title, description: fm.description, body: "仅用于解析路径", tags: ["route"], zone, project, type, category, expires });
	if (!target.path) throw new Error(target.error);
	if (existsSync(resolveRepoPath(target.path).abs)) throw new Error(`目标文件已存在：${target.path}`);
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---([\s\S]*)$/);
	if (!match) throw new Error("草案缺少 frontmatter");
	const fields = match[1].split(/\r?\n/).filter((line) => !/^\s*(type|scope|expires)\s*:/.test(line));
	fields.push(`type: ${type}`);
	if (zone === "project") fields.push("scope: project");
	if (expires) fields.push(`expires: ${expires}`);
	return { rel: target.path, content: `---\n${fields.join("\n")}\n---${match[2]}` };
}

function pendingMatches(source: { rel: string; text: string }): boolean {
	const file = resolveRepoPath(source.rel).abs;
	return existsSync(file) && readFileSync(file, "utf8") === source.text;
}

async function writeFormal(
	pi: ExtensionAPI,
	ctx: Ctx,
	relInput: string,
	content: string,
	commitNote = "",
	pendingSource?: { rel: string; text: string },
): Promise<WriteResult> {
	return withRepoMutation(async () => {
		const rel = resolveRepoPath(relInput).rel;
		if (!isFormalMemoryPath(rel)) return { success: false, text: `✗ 目标不是合法的正式记忆路径：${rel}` };
		const ready = await prepareWritableRepo(pi);
		if (ready.result) return ready.result;
		if (existsSync(resolveRepoPath(rel).abs)) return { success: false, text: `✗ 目标文件已存在：${rel}` };

		const first = await buildWriteChanges(rel, content);
		if (typeof first === "string") return { success: false, text: first };
		const editable: EditableDraft = {
			rel,
			canRelocate: true,
			rebuild: async (edited, target) => {
				if (!isFormalMemoryPath(target)) return { error: "不是合法的正式记忆路径" };
				if (existsSync(resolveRepoPath(target).abs)) return { error: `目标文件已存在：${target}` };
				const rebuilt = await buildWriteChanges(target, edited);
				return typeof rebuilt === "string" ? { error: rebuilt } : { changes: rebuilt };
			},
		};
		const result = await commitPreparedChanges(pi, ctx, first, ready.head!, "memark：确认以下修改？",
			() => `memory: ${editable.rel}${commitNote ? ` (${commitNote})` : ""}`, editable, pendingSource);
		if (result.success) result.text = `${result.text}\n${editable.rel}`;
		return result;
	}, { signal: ctx.signal });
}

/** 用新措辞重建记忆文件；frontmatter 其余字段沿用原值。 */
function buildEditedFile(d: Draft, original: string): string {
	validateDraft(d);
	return rewriteMemory(original, {
		title: scalar(d.title.trim()), description: scalar(d.description.trim()),
		tags: `[${d.tags.map((tag) => scalar(tag.trim())).join(", ")}]`,
	}, `\n${d.body.trim()}\n`);
}

/** 由模型改写已有记忆的措辞：只更新标题、描述、标签和正文，其余 frontmatter 沿用原值。 */
async function writeEdited(pi: ExtensionAPI, ctx: Ctx, relInput: string, d: Draft): Promise<WriteResult> {
	return withRepoMutation(async () => {
		const rel = resolveRepoPath(relInput).rel;
		if (!isFormalMemoryPath(rel)) return { success: false, text: `✗ 不是合法的正式记忆路径：${rel}` };
		const ready = await prepareWritableRepo(pi);
		if (ready.result) return ready.result;
		const source = resolveRepoPath(rel).abs;
		if (!existsSync(source)) return { success: false, text: `✗ 待编辑记忆不存在：${rel}` };
		const original = readFileSync(source, "utf8");
		if (parseMetadata(original)?.status !== "active") return { success: false, text: `✗ 只能编辑 status: active 的记忆：${rel}` };
		const fm = parseSimpleFrontmatter(original);
		const effective: Draft = {
			...d,
			type: fm.type ?? d.type,
			timestamp: fm.timestamp,
			expires: fm.expires,
			supersedes: undefined,
		};
		let content: string;
		try {
			content = buildEditedFile(effective, original);
		} catch (err) {
			return { success: false, text: `✗ 编辑草案未通过校验：${(err as Error).message}` };
		}
		const changes: Changes = new Map([[rel, content]]);
		const result = await commitPreparedChanges(pi, ctx, changes, ready.head!, "memark：确认编辑以下记忆？", `memory: edit ${rel}`, {
			rel,
			rebuild: async (edited) => ({ changes: new Map([[rel, edited]]) }),
		});
		if (result.success) result.text = `${result.text}\n${rel}`;
		return result;
	}, { signal: ctx.signal });
}

export function registerCurator(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "memark_remember",
		label: "Memory Remember",
		description:
			"将一条用户明确要求记住的内容写入记忆仓库：先在临时副本校验并展示修改预览（Yes / No / Edit，可当场编辑措辞），用户确认后才写入正式目录、精确提交并推送。" +
			"新建记忆在无可靠 UI、离线或仓库存在未处理修改时只保存本机 pending/；原地编辑无法审核时停止，须重新发起。" +
			"个人区 zone=personal；项目区 zone=project + project。目录由 type 唯一推导，项目区与 knowledge 不要传 category 值（可省略或传 null）；Handoff 必须设置 expires。" +
			"优先核对已有项目，跨项目规则归个人区；新项目及辅助文件必须在预览中由用户批准。不得为绕过错误改变适用范围。" +
			`调整已有记忆措辞时提供 edit=<仓库相对路径> 原地更新。仅在用户明确要求记住或修改时调用。运行：${runtime.label}。`,
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
			layer: optionalNullable(StringEnum(["identity", "principles", "preferences", "context", "knowledge"] as const), "个人区可省略，按 type 推导；项目区不使用"),
			category: optionalNullable(StringEnum(["current", "relationships"] as const), "仅个人区 Context 可指定 current/relationships；其余类型目录完全由 type 推导"),
			project: optionalNullable(Type.String(), "项目名（zone=project 必填）；个人区不使用"),
			type: StringEnum(ALL_TYPES),
			expires: optionalNullable(Type.String(), "真实的 YYYY-MM-DD 日期（Handoff 必填）"),
			supersedes: optionalNullable(Type.String(), "被取代记忆的仓库相对路径"),
			edit: optionalNullable(Type.String(), "原地改写的已有记忆仓库相对路径（调整措辞）；提供时只采用 title/description/body/tags，保留原 type/timestamp/scope/expires/supersedes"),
			as_pending: optionalNullable(Type.Boolean(), "只保存为本机待审核候选；省略或 null 不跳过用户审核"),
		}),
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args as never;
			try {
				return normalizeLocation(args as Draft) as never;
			} catch (err) {
				throw new Error(`memark_remember 参数错误 [${runtime.label}]：${(err as Error).message}`);
			}
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				if (signal?.aborted) throw new Error("操作已取消");
				const draft = normalizeLocation(params as unknown as Draft);
				const context: Ctx = { ...ctx, signal: signal ?? ctx?.signal };
				if (draft.edit) {
					const result = await writeEdited(pi, context, draft.edit, draft);
					return { content: [{ type: "text", text: result.text }], details: {} };
				}
				const target = resolveTargetPath(draft);
				if (target.error || !target.path) throw new Error(target.error ?? "无法解析目标路径");
				const rel = target.path;
				if (existsSync(resolveRepoPath(rel).abs)) {
					throw new Error(`目标文件已存在：${rel}。调整措辞请用 edit 参数原地更新；替代旧记忆请用新标题并设置 supersedes。`);
				}
				if (draft.supersedes && resolveRepoPath(draft.supersedes).rel === rel) {
					throw new Error("新记忆不能用同一路径取代自身");
				}

				if (draft.as_pending || !ctx?.hasUI) {
					const text = await savePending(pi, draft, rel);
					return { content: [{ type: "text", text }], details: {} };
				}

				const result = await writeFormal(pi, context, rel, buildFile(draft));
				if (!result.success && result.deferred && !context.signal?.aborted) {
					const pending = await savePending(pi, result.candidate?.content ?? draft, result.candidate?.rel ?? rel);
					result.text = `${result.text}\n${pending}`;
				}
				return { content: [{ type: "text", text: result.text }], details: {} };
			} catch (err) {
				throw new Error(`memark_remember 失败 [${runtime.label}]：${(err as Error).message}`);
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
			const fields = parseMetadata(text);
			const expiry = fields?.expires;
			if (fields?.status === "active" && validDate(expiry) && expiry < todayValue) expired.push(match[1]);
		} catch {
			// maintain 会由仓库校验报告缺失文件。
		}
	}
	return expired;
}

async function revisionFile(pi: ExtensionAPI, revision: string, rel: string): Promise<string | null> {
	const listed = await git(pi, ["ls-tree", "-r", "--name-only", "-z", revision, "--", rel]);
	if (listed.code !== 0) throw new Error(`无法读取撤销基准：${listed.stderr || listed.stdout}`);
	if (!listed.stdout.split("\0").includes(rel)) return null;
	const file = await git(pi, ["show", `${revision}:${rel}`]);
	if (file.code !== 0) throw new Error(`无法读取历史文件：${file.stderr || file.stdout}`);
	return file.stdout;
}

/** 只反转记忆事务；非索引文件若被后续提交改变，则拒绝猜测合并。索引交给协议重建。 */
async function revertChanges(pi: ExtensionAPI, hash: string): Promise<Changes> {
	const changed = await git(pi, ["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", hash]);
	if (changed.code !== 0) throw new Error(`无法读取撤销清单：${changed.stderr || changed.stdout}`);
	const changes: Changes = new Map();
	for (const path of changed.stdout.split("\0").filter(Boolean)) {
		const rel = resolveRepoPath(path).rel;
		const index = rel === "INDEX.md" || /^projects\/[^/]+\/INDEX\.md$/.test(rel);
		const managed = isFormalMemoryPath(rel) || (rel.startsWith("archive/") && isFormalMemoryPath(rel.slice(8))) || /^projects\/[^/]+\/README\.md$/.test(rel);
		if (!index && !managed) throw new Error(`该提交包含非记忆文件，拒绝自动撤销：${rel}`);
		if (!index && await revisionFile(pi, "HEAD", rel) !== await revisionFile(pi, hash, rel)) {
			throw new Error(`后续提交已修改 ${rel}，请人工处理撤销`);
		}
		changes.set(rel, await revisionFile(pi, `${hash}^`, rel));
	}
	if (changes.size === 0) throw new Error("没有可撤销的文件");
	return changes;
}

/** /memory 命令族入口。 */
export async function handleMemoryCommand(pi: ExtensionAPI, args: string, ctx: Ctx): Promise<void> {
	const { cmd, rest } = parseMemoryArgs(args);
	const notify = (message: string, tone: "info" | "warning" | "error" = "info") => ctx.ui.notify(message, tone);

	if (cmd === "status") {
		notify(runtime.status(), "info");
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

		const text = await withFileMutationQueue(file, async () => readFileSync(file, "utf8"));
		const source = { rel: `pending/${id}.md`, text };
		const fm = parseSimpleFrontmatter(text);
		if (!fm.target) {
			notify(`pending/${id}.md 缺少 target 字段。`, "error");
			return;
		}
		let result: WriteResult;
		try {
			result = await writeFormal(pi, ctx, fm.target, pendingToFormal(text), id, source);
		} catch (err) {
			notify(`批准失败：${(err as Error).message}`, "error");
			return;
		}
		if (result.success) await withFileMutationQueue(file, async () => {
			if (pendingMatches(source)) rmSync(file);
			else result.text += "\n⚠ pending 已有新版本，已保留；本次仅提交了审核过的版本。";
		});
		else if (result.deferred && result.candidate && !ctx.signal?.aborted) {
			const latest = buildPendingFile(result.candidate.content, result.candidate.rel);
			const error = await scanCandidate(pi, latest);
			if (error) throw new Error(`编辑后的候选未保存：${error}`);
			await withFileMutationQueue(file, async () => {
				if (!pendingMatches(source)) throw new Error("pending 在审核期间已变化或被拒绝，未覆盖");
				writeFileSync(file, latest, { mode: 0o600 });
			});
		}
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
				if (parseMetadata(original)?.status !== "active") return { success: false, text: "只能归档 status: active 的记忆" };
				const destination = resolveRepoPath(`archive/${rel}`).rel;
				if (existsSync(resolveRepoPath(destination).abs)) return { success: false, text: `归档目标已存在：${destination}` };
				const changes: Changes = new Map([
					[rel, null],
					[destination, rewriteMemory(original, { status: "archived" })],
				]);
				return commitPreparedChanges(pi, ctx, changes, ready.head!, "memark：确认归档以下记忆？", `memory: archive ${rel}`);
			});
		} catch (err) {
			result = { success: false, text: `归档失败：${(err as Error).message}` };
		}
		notify(result.text, result.success ? "info" : "error");
		return;
	}

	if (cmd === "edit") {
		const input = rest[0];
		if (!input) {
			notify("用法：/memory edit <正式记忆相对路径>", "warning");
			return;
		}
		let result: WriteResult;
		try {
			result = await withRepoMutation(async () => {
				const rel = resolveRepoPath(input).rel;
				if (!isFormalMemoryPath(rel)) return { success: false, text: `拒绝编辑非正式记忆路径：${rel}` };
				const ready = await prepareWritableRepo(pi);
				if (ready.result) return ready.result;
				const source = resolveRepoPath(rel).abs;
				if (!existsSync(source)) return { success: false, text: `文件不存在：${rel}` };
				const editor = ctx.hasUI && typeof ctx.ui.editor === "function" ? ctx.ui.editor : undefined;
				if (!editor) return { success: false, text: "编辑需要在交互模式的终端编辑器中进行。" };
				const original = readFileSync(source, "utf8");
				const edited = await editor(`memark：编辑 ${rel}（Enter 保存 / Esc 取消）`, original);
				if (edited === undefined) return { success: false, text: "已取消，正式仓库未改动。" };
				if (edited === original) return { success: false, text: "内容未变化，正式仓库未改动。" };
				const changes: Changes = new Map([[rel, edited]]);
				return commitPreparedChanges(pi, ctx, changes, ready.head!, "memark：确认编辑以下记忆？", `memory: edit ${rel}`, {
					rel,
					rebuild: async (content) => ({ changes: new Map([[rel, content]]) }),
				});
			});
		} catch (err) {
			result = { success: false, text: `编辑失败：${(err as Error).message}` };
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
				const errors = await runReadOnlyChecks(pi);
				if (errors) throw new Error(`当前仓库校验失败：${errors}`);
				const changes = await revertChanges(pi, target.hash);
				const result = await commitPreparedChanges(pi, ctx, changes, baseHead,
					"memark：确认撤销这次记忆修改？", `Revert "${target.subject}"\n\nThis reverts commit ${target.hash}.`);
				notify(result.success ? `已撤销：${target.subject}\n${result.text}` : result.text, result.success ? "info" : "warning");
			}, { signal: ctx.signal });
		} catch (err) {
			notify(`撤销失败：${(err as Error).message}`, "error");
		}
		return;
	}

	notify(`未知子命令：${cmd}。可用：status / sync / review / approve / reject / maintain / forget / edit / revert`, "warning");
}
