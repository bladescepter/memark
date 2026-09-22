/**
 * memark curator —— P3：记忆写入流程。
 *
 * 原则（方案 §8）：自动系统只产候选，正式写入必须经用户确认。
 *   memark_remember 工具：草案 → 仓库校验（schema/secret/去重/索引）→ ctx.ui.confirm → 一条一 commit → push
 *   无 UI 模式（print/json）：自动降级为只写 pending/，不做提交
 *   /memory 命令族：status / review / approve / reject / forget / revert（§8.4）
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, LAYERS, PROJECTS_DIR, REPO, countMd, readIndex, runRepoScript } from "./repo";

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
const PROJECT_TYPE_NAMES = ["Decision", "Topic", "Incident", "Handoff"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

/** 由草案解析目标相对路径并做结构校验（协议镜像，最终以仓库脚本校验为准） */
export function resolveTargetPath(d: Draft): { path: string | null; error?: string } {
	const filename = d.title.replace(/[\s/\\]+/g, "");
	if (!filename) return { path: null, error: "title 无法生成合法文件名" };
	if (d.zone === "personal") {
		const layer = d.layer ?? "";
		if (!PERSONAL_TYPES[layer]) {
			return { path: null, error: `个人区 layer 必须是 ${Object.keys(PERSONAL_TYPES).join("/")}` };
		}
		if (!PERSONAL_TYPES[layer].includes(d.type)) {
			return { path: null, error: `${layer}/ 的 type 须为 ${PERSONAL_TYPES[layer].join("/")}` };
		}
		if (d.category) {
			if (!(PERSONAL_SUBDIRS[layer] ?? []).includes(d.category)) {
				return { path: null, error: `${layer}/ 不允许二级目录 ${d.category}（可选：${(PERSONAL_SUBDIRS[layer] ?? []).join("/") || "无"}）` };
			}
			return { path: `${layer}/${d.category}/${filename}.md` };
		}
		return { path: `${layer}/${filename}.md` };
	}
	if (!d.project || !/^[\w\u4e00-\u9fff.-]+$/.test(d.project)) {
		return { path: null, error: "项目区必须提供合法 project 名" };
	}
	if (d.category) {
		if (!PROJECT_TYPES[d.category]) {
			return { path: null, error: `项目区 category 必须是 ${Object.keys(PROJECT_TYPES).join("/")}` };
		}
		if (!PROJECT_TYPES[d.category].includes(d.type)) {
			return { path: null, error: `${d.category}/ 的 type 须为 ${PROJECT_TYPES[d.category].join("/")}` };
		}
		return { path: `projects/${d.project}/${d.category}/${filename}.md` };
	}
	if (!PROJECT_TYPE_NAMES.includes(d.type)) {
		return { path: null, error: `项目区 type 须为 ${PROJECT_TYPE_NAMES.join("/")}` };
	}
	return { path: `projects/${d.project}/${filename}.md` };
}

/** 生成记忆文件全文 */
export function buildFile(d: Draft, extraFields: Record<string, string> = {}): string {
	const lines = [
		"---",
		`type: ${d.type}`,
		`title: ${d.title}`,
		`description: ${d.description}`,
		"status: active",
		"privacy: internal",
		`tags: [${d.tags.join(", ")}]`,
		`timestamp: ${d.timestamp ?? today()}`,
	];
	if (d.zone === "project") lines.push("scope: project");
	if (d.expires) lines.push(`expires: ${d.expires}`);
	if (d.supersedes) lines.push(`supersedes: ${d.supersedes}`);
	lines.push("source: user-confirmed", "reviewed: true");
	for (const [k, v] of Object.entries(extraFields)) lines.push(`${k}: ${v}`);
	lines.push("---", "", d.body, "");
	return lines.join("\n");
}

/** 极简 frontmatter 解析（仅用于 pending 文件与展示） */
export function parseSimpleFrontmatter(text: string): Record<string, string> {
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return {};
	const out: Record<string, string> = {};
	for (const line of m[1].split(/\r?\n/)) {
		const i = line.indexOf(":");
		if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	return out;
}

/** 解析 /memory 命令参数 */
export function parseMemoryArgs(args: string): { cmd: string; rest: string[] } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	return { cmd: parts[0] ?? "status", rest: parts.slice(1) };
}

function pendingDir(): string {
	return join(REPO, "pending");
}

export function listPendingIds(): string[] {
	if (!existsSync(pendingDir())) return [];
	return readdirSync(pendingDir())
		.filter((f) => f.endsWith(".md") && f !== "README.md")
		.map((f) => f.replace(/\.md$/, ""))
		.sort();
}

/** 运行仓库三件校验；返回错误文本或 null */
async function runChecks(pi: ExtensionAPI): Promise<string | null> {
	const failures: string[] = [];
	for (const script of ["generate_index.py", "validate.py", "secret_scan.py"]) {
		const r = await runRepoScript(pi, script);
		if (r.code !== 0) failures.push((r.stderr || r.stdout).trim());
	}
	return failures.length ? failures.join("\n") : null;
}

/** 从 git 干净状态回滚未提交改动（写入失败/用户拒绝时） */
async function cleanupUncommitted(pi: ExtensionAPI, files: string[]): Promise<void> {
	for (const f of files) {
		const abs = join(REPO, f);
		if (existsSync(abs)) rmSync(abs);
		// 移除因新建文件而产生的空目录（如 projects/<新项目>/topics/）
		let dir = dirname(abs);
		while (dir.startsWith(REPO) && dir !== REPO) {
			try {
				rmdirSync(dir);
			} catch {
				break;
			}
			dir = dirname(dir);
		}
	}
	await git(pi, ["checkout", "--", "."]);
	await runRepoScript(pi, "generate_index.py");
}

interface Ctx {
	hasUI?: boolean;
	ui: {
		confirm: (title: string, message: string) => Promise<boolean>;
		notify: (message: string, tone?: "info" | "warning" | "error") => void;
	};
	cwd?: string;
}

/** 正式写入流程：pull → 写文件 → 校验 → 确认 → commit → push */
async function writeFormal(
	pi: ExtensionAPI,
	ctx: Ctx,
	rel: string,
	content: string,
	commitNote: string,
): Promise<string> {
	const pull = await git(pi, ["pull", "--ff-only"]);
	if (pull.code !== 0) {
		return `✗ git pull --ff-only 失败（远端有新提交或分叉），已停止，请人工处理：\n${pull.stderr.trim()}`;
	}
	writeFileSync(join(REPO, rel), content);
	const checkErrors = await runChecks(pi);
	if (checkErrors) {
		await cleanupUncommitted(pi, [rel]);
		return `✗ 仓库校验未通过，未写入：\n${checkErrors}`;
	}
	const ok = ctx.hasUI ? await ctx.ui.confirm("memark：写入这条记忆？", `${rel}\n\n${content.trim()}`) : false;
	if (!ok) {
		await cleanupUncommitted(pi, [rel]);
		return "已取消，未写入。";
	}
	await git(pi, ["add", "-A"]);
	const c = await git(pi, ["commit", "-m", `memory: ${rel}${commitNote ? ` (${commitNote})` : ""}`]);
	if (c.code !== 0) {
		await cleanupUncommitted(pi, [rel]);
		return `✗ git commit 失败：\n${c.stderr.trim()}`;
	}
	const p = await git(pi, ["push"]);
	const hash = (await git(pi, ["rev-parse", "--short", "HEAD"])).stdout.trim();
	return p.code === 0
		? `✓ 已写入并推送：${rel}（${hash}）`
		: `✓ 已写入：${rel}（${hash}）\n⚠ push 失败，稍后请手动同步：${p.stderr.trim()}`;
}

export function registerCurator(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "memark_remember",
		label: "Memory Remember",
		description:
			"将一条用户要求记住的内容写入记忆仓库（curator 流程）：生成草案 → 运行仓库校验（schema/secret/去重/索引）→ " +
			"展示完整草案请用户确认 → 一条一 commit 并推送。无 UI 时只写入 pending/ 待 /memory approve。" +
			"分区规则：个人区 zone=personal（layer: identity/principles/preferences/context/knowledge，" +
			"type 对应 Identity/Principle/Preference/Context/Skill/Experience/Learning，category 仅 context→current/relationships、knowledge→skills/experiences/learnings）；" +
			"项目区 zone=project（project=项目名，category: decisions/topics/incidents/handoffs，type 对应 Decision/Topic/Incident/Handoff，handoffs 须给 expires）。" +
			"仅在用户明确要求记住时调用。",
		promptSnippet: "Write a user-approved memory into the memark repo (draft, validate, confirm, one commit)",
		promptGuidelines: [
			"Use memark_remember only when the user explicitly asks to remember something; it always shows a draft and waits for user confirmation before committing.",
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
			type: Type.String({ description: "记忆类型，须与 layer/category 匹配" }),
			expires: Type.Optional(Type.String({ description: "YYYY-MM-DD（Handoff 必填）" })),
			supersedes: Type.Optional(Type.String({ description: "被取代记忆的仓库相对路径" })),
			as_pending: Type.Optional(Type.Boolean({ description: "只入 pending 待审（默认 false，直接走确认流程）" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const draft = params as unknown as Draft;
				if (draft.type === "Handoff" && !draft.expires) {
					throw new Error("Handoff 类型必须提供 expires（YYYY-MM-DD）");
				}
				if (draft.expires && !DATE_RE.test(draft.expires)) {
					throw new Error("expires 须为 YYYY-MM-DD 格式");
				}
				const target = resolveTargetPath(draft);
				if (target.error || !target.path) throw new Error(target.error ?? "无法解析目标路径");
				const rel = target.path;
				if (existsSync(join(REPO, rel))) {
					throw new Error(`目标文件已存在：${rel}。如为更新请用 supersedes 指向原文件。`);
				}
				if (draft.supersedes && !existsSync(join(REPO, draft.supersedes))) {
					throw new Error(`supersedes 目标不存在：${draft.supersedes}`);
				}

				// pending 降级路径：显式 as_pending 或无 UI
				if (params.as_pending || !ctx?.hasUI) {
					const id = `${today().replace(/-/g, "")}-${rel.split("/").pop()!.replace(/\.md$/, "")}`;
					writeFileSync(join(pendingDir(), `${id}.md`), buildFile(draft, { target: rel }));
					return {
						content: [{
							type: "text",
							text:
								`已写入 pending/${id}.md（目标 ${rel}），未提交。` +
								"请用户用 /memory review 查看、/memory approve <id> 批准或 /memory reject <id> 拒绝。",
						}],
					};
				}

				// supersedes：原条目原地标记 superseded（不移动文件，保留路径与历史）
				let oldRel: string | null = null;
				let oldText: string | null = null;
				if (draft.supersedes) {
					oldRel = draft.supersedes;
					oldText = readFileSync(join(REPO, oldRel), "utf8");
					writeFileSync(join(REPO, oldRel), oldText.replace(/^status: active$/m, "status: superseded"));
				}

				const result = await writeFormal(pi, ctx as Ctx, rel, buildFile(draft), "");
				if (result.startsWith("✓") && oldRel && oldText) {
					// 新条目与 superseded 标记同一 commit，无需额外处理
				} else if (!result.startsWith("✓") && oldRel && oldText) {
					writeFileSync(join(REPO, oldRel), oldText);
				}
				return { content: [{ type: "text", text: result }] };
			} catch (err) {
				throw new Error(`memark_remember 失败：${(err as Error).message}`);
			}
		},
	});
}

/** /memory 命令族入口 */
export async function handleMemoryCommand(pi: ExtensionAPI, args: string, ctx: Ctx): Promise<void> {
	const { cmd, rest } = parseMemoryArgs(args);
	const notify = (m: string, tone: "info" | "warning" | "error" = "info") => ctx.ui.notify(m, tone);

	if (cmd === "status") {
		if (!existsSync(REPO)) {
			notify(`memark：记忆仓库不存在（${REPO}）。设置 MEMARK_REPO 环境变量，或按协议创建 memory 仓库。`, "warning");
			return;
		}
		const entries = readIndex().filter((l) => l.includes(".md")).length;
		const pending = countMd(join(REPO, "pending"));
		const counts = LAYERS.map((l) => `${l}: ${countMd(join(REPO, l))}`).join("  ");
		let projectInfo = "无";
		const projectsRoot = join(REPO, PROJECTS_DIR);
		if (existsSync(projectsRoot)) {
			const names = readdirSync(projectsRoot, { withFileTypes: true })
				.filter((e) => e.isDirectory())
				.map((e) => e.name)
				.sort();
			if (names.length > 0) projectInfo = names.map((n) => `${n}: ${countMd(join(projectsRoot, n))}`).join("  ");
		}
		const { stdout: st, code } = await git(pi, ["status", "--porcelain"]);
		const dirty = code === 0 ? st.split("\n").filter(Boolean).length : -1;
		const { stdout: br } = await git(pi, ["branch", "--show-current"]);
		const gitInfo =
			dirty === -1 ? "非 git 仓库" : `${br.trim() || "?"}${dirty > 0 ? `（${dirty} 处未提交）` : "（干净）"}`;
		notify(
			`memark @ ${REPO}\n个人区索引条目: ${entries}  pending: ${pending}  git: ${gitInfo}\n${counts}\n项目区: ${projectInfo}\n子命令：review / approve <id> / reject <id> / forget <path> / revert`,
			"info",
		);
		return;
	}

	if (cmd === "review") {
		const ids = listPendingIds();
		if (ids.length === 0) {
			notify("pending 为空，没有待审候选。", "info");
			return;
		}
		const lines = ids.map((id) => {
			const fm = parseSimpleFrontmatter(readFileSync(join(pendingDir(), `${id}.md`), "utf8"));
			return `${id}  →  ${fm.target ?? "?"}  ｜ ${fm.title ?? "?"}`;
		});
		notify(`pending 候选（${ids.length} 条）：\n${lines.join("\n")}\n/memory approve <id> 批准；/memory reject <id> 拒绝`, "info");
		return;
	}

	if (cmd === "approve" || cmd === "reject") {
		const id = rest[0]?.replace(/\.md$/, "");
		if (!id) {
			notify(`用法：/memory ${cmd} <id>（先 /memory review 查看候选）`, "warning");
			return;
		}
		const file = join(pendingDir(), `${id}.md`);
		if (!existsSync(file)) {
			notify(`pending/${id}.md 不存在。`, "error");
			return;
		}
		if (cmd === "reject") {
			rmSync(file);
			notify(`已拒绝并删除 pending/${id}.md${rest[1] ? `（原因：${rest.slice(1).join(" ")}）` : ""}`, "info");
			return;
		}
		const text = readFileSync(file, "utf8");
		const fm = parseSimpleFrontmatter(text);
		const rel = fm.target;
		if (!rel) {
			notify(`pending/${id}.md 缺少 target 字段，无法定位目标路径。`, "error");
			return;
		}
		const content = text
			.split(/\r?\n/)
			.filter((l) => !/^target: /.test(l))
			.join("\n");
		if (existsSync(join(REPO, rel))) {
			notify(`目标已存在：${rel}，请检查是否重复。`, "error");
			return;
		}
		const result = await writeFormal(pi, ctx, rel, content, id);
		if (result.startsWith("✓")) rmSync(file);
		notify(result, result.startsWith("✓") ? "info" : "warning");
		return;
	}

	if (cmd === "forget") {
		const rel = rest[0];
		if (!rel) {
			notify("用法：/memory forget <仓库相对路径>（记忆将移入 archive/ 并保留 git 历史）", "warning");
			return;
		}
		const abs = join(REPO, rel);
		if (!existsSync(abs)) {
			notify(`文件不存在：${rel}`, "error");
			return;
		}
		const text = readFileSync(abs, "utf8").replace(/^status: active$/m, "status: archived");
		const archivePath = join(REPO, "archive");
		const dest = join(archivePath, rel.split("/").pop()!);
		if (existsSync(dest)) {
			notify(`archive/ 已存在同名文件：${dest}`, "error");
			return;
		}
		const ok = ctx.hasUI
			? await ctx.ui.confirm("memark：归档这条记忆？", `${rel} → archive/（git 历史保留，可用 /memory revert 撤销本次操作）`)
			: false;
		if (!ok) {
			notify("已取消。", "info");
			return;
		}
		const pull = await git(pi, ["pull", "--ff-only"]);
		if (pull.code !== 0) {
			notify(`git pull --ff-only 失败，已停止：\n${pull.stderr.trim()}`, "error");
			return;
		}
		writeFileSync(dest, text);
		rmSync(abs);
		const checkErrors = await runChecks(pi);
		if (checkErrors) {
			rmSync(dest);
			await git(pi, ["checkout", "--", "."]);
			await runRepoScript(pi, "generate_index.py");
			notify(`校验未通过，已回滚：\n${checkErrors}`, "error");
			return;
		}
		await git(pi, ["add", "-A"]);
		const c = await git(pi, ["commit", "-m", `memory: archive ${rel}`]);
		if (c.code !== 0) {
			notify(`commit 失败：${c.stderr.trim()}`, "error");
			return;
		}
		const p = await git(pi, ["push"]);
		notify(`✓ 已归档 ${rel}${p.code === 0 ? " 并推送" : "（push 失败，稍后手动同步）"}`, "info");
		return;
	}

	if (cmd === "revert") {
		// 找最近一次尚未被回滚的记忆写入（跳过 Revert 提交本身）
		const { stdout: log } = await git(pi, ["log", "-30", "--pretty=%h %s"]);
		const reverted = new Set<string>();
		let target: { hash: string; subject: string } | null = null;
		for (const line of log.split("\n")) {
			const m = line.match(/^([0-9a-f]+) (.+)$/);
			if (!m) continue;
			const subject = m[2];
			const rv = subject.match(/^Revert "(.*)"$/);
			if (rv) {
				reverted.add(rv[1]);
				continue;
			}
			if (subject.startsWith("memory:") && !reverted.has(subject)) {
				target = { hash: m[1], subject };
				break;
			}
		}
		if (!target) {
			notify("最近 30 条 commit 中没有未回滚的记忆写入。", "warning");
			return;
		}
		const ok = ctx.hasUI
			? await ctx.ui.confirm("memark：回滚这次记忆写入？", target.subject)
			: false;
		if (!ok) {
			notify("已取消。", "info");
			return;
		}
		const r = await git(pi, ["revert", "--no-edit", target.hash]);
		if (r.code !== 0) {
			notify(`git revert 失败：${r.stderr.trim()}`, "error");
			return;
		}
		const p = await git(pi, ["push"]);
		notify(`✓ 已回滚：${target.subject}${p.code === 0 ? " 并推送" : "（push 失败，稍后手动同步）"}`, "info");
		return;
	}

	notify(`未知子命令：${cmd}。可用：status / review / approve / reject / forget / revert`, "warning");
}
