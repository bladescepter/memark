/**
 * memark — memory + markdown，pi 编码代理的长期记忆扩展。
 *
 * v0.3（当前）
 *   - memark_recall 工具：相关性排序检索（标题>描述>tags 加权），默认范围=个人区+当前项目区
 *   - memark_remember 工具（curator）：草案→仓库校验→用户确认→一条一 commit→push；无 UI 降级只写 pending
 *   - /memory 命令族：status / review / approve / reject / forget / revert
 *
 * v0.4+（计划，见 docs/记忆系统重构完整方案.md §7）
 *   - Gate：agent_settled → 本地硬规则 + secret scan → Jev 结构化判断 → pending 入队
 *   - 基线注入：before_agent_start 注入 ≤600 tokens 稳定基线
 *
 * 记忆仓库路径：环境变量 MEMARK_REPO，默认 ~/DEV/memory。
 * 仓库协议（README 路由权威、单仓双区、frontmatter）由记忆仓库自身承载与校验。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { PROJECTS_DIR, REPO, git, readIndex } from "./repo";
import { handleMemoryCommand, listPendingIds, registerCurator } from "./curator";

const MAX_FILE_CHARS = 4000;

/** 当前项目对应的记忆目录（projects/<项目名>）；无项目索引时返回 null */
function projectDirFor(cwd?: string): string | null {
	const explicit = process.env.MEMARK_PROJECT?.trim();
	let name = explicit;
	if (!name && cwd) name = basename(resolve(cwd));
	if (!name) return null;
	const dir = join(REPO, PROJECTS_DIR, name);
	return existsSync(join(dir, "INDEX.md")) ? dir : null;
}

/** 从 INDEX 条目行解析记忆文件相对路径（行尾最后一个 " — " 之后、以 .md 结尾的部分） */
function pathFromIndexLine(line: string): string | null {
	const m = line.match(/—\s*(\S+\.md)\s*$/);
	return m ? m[1] : null;
}

/** 解析 INDEX 条目行：- [Type] title — description — tags: a, b — path.md */
function parseIndexLine(line: string): { title: string; description: string; tags: string } | null {
	const m = line.match(/^- \[[^\]]+\]\s+(.*)$/);
	if (!m) return null;
	const pm = m[1].match(/—\s*(\S+\.md)\s*$/);
	if (!pm) return null;
	const body = m[1].slice(0, pm.index ?? 0).trimEnd();
	const parts = body.split(/\s+—\s+/);
	if (parts.length < 2) return null;
	const tags = (parts.length >= 3 ? parts[parts.length - 1] : "").replace(/^tags:\s*/, "");
	const description = parts[parts.length - 2] ?? "";
	const title = parts[0] ?? "";
	return { title, description, tags };
}

/**
 * 对 INDEX 行做相关性匹配并排序：标题命中权重最高，其次描述、tags；
 * 多词全部命中加成。返回去重后的相对路径，按分数降序。
 */
export function matchIndexLines(lines: string[], query: string): string[] {
	const tokens = query.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
	if (tokens.length === 0) return [];
	const lowerQuery = query.toLowerCase();
	const scored: { path: string; score: number; order: number }[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.includes(".md")) continue;
		const low = line.toLowerCase();
		const anyHit =
			tokens.some((t) => low.includes(t)) || (tokens.length > 1 && low.includes(lowerQuery));
		if (!anyHit) continue;
		const rel = pathFromIndexLine(line);
		if (!rel) continue;
		const parsed = parseIndexLine(line);
		let score = 1;
		let tokenHits = 0;
		if (parsed) {
			const title = parsed.title.toLowerCase();
			const desc = parsed.description.toLowerCase();
			const tags = parsed.tags.toLowerCase();
			score = 0;
			for (const t of tokens) {
				if (title.includes(t)) {
					score += 3;
					tokenHits++;
				} else if (desc.includes(t)) {
					score += 2;
					tokenHits++;
				} else if (tags.includes(t)) {
					score += 1;
					tokenHits++;
				} else {
					score += 1; // 仅路径或其他位置命中
				}
			}
			if (tokens.length > 1 && tokenHits === tokens.length) score += 2;
		}
		if (tokens.length > 1 && low.includes(lowerQuery)) score += 2;
		scored.push({ path: rel, score, order: i });
	}
	return scored
		.sort((a, b) => b.score - a.score || a.order - b.order)
		.map((s) => s.path)
		.filter((p, i, arr) => arr.indexOf(p) === i);
}

export default function (pi: ExtensionAPI) {
	// ---------- recall 工具 ----------
	pi.registerTool({
		name: "memark_recall",
		label: "Memory Recall",
		description:
			"检索个人长期记忆库（memark，Markdown 仓库）并返回与当前任务相关的记忆条目，" +
			"默认范围 = 个人区 + 当前项目的项目区（projects/<项目名>）。" +
			"在需要了解用户偏好、过往决策、工作纪律、项目约定时调用。" +
			"返回「仓库未初始化」时说明记忆库尚未建立，正常继续任务即可，不要猜测记忆内容。",
		promptSnippet: "Search personal long-term memory (memark) for preferences, decisions and conventions",
		promptGuidelines: [
			"Use memark_recall when prior context about the user's preferences, past decisions, or established conventions would change how you approach the task.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "检索词（中文或英文关键词，可多个空格分隔）" }),
			max_files: Type.Optional(
				Type.Number({ minimum: 1, maximum: 10, description: "最多返回的记忆文件数，默认 3" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const projectDir = projectDirFor(ctx?.cwd);
			const personalLines = readIndex();
			const projectLines = projectDir ? readIndex(projectDir) : [];
			if (personalLines.length === 0 && projectLines.length === 0) {
				return {
					content: [{
						type: "text",
						text:
							`memark：记忆仓库未初始化（${REPO} 缺少 INDEX.md）。` +
							"请正常继续当前任务；记忆库建立协议见 memark 扩展仓库 docs/记忆系统重构完整方案.md。",
					}],
				};
			}

			const lines = [...personalLines, ...projectLines];
			const uniq = matchIndexLines(lines, params.query).slice(0, params.max_files ?? 3);
			if (uniq.length === 0) {
				const summary = lines.filter((l) => l.includes(".md")).slice(0, 40).join("\n");
				const scopeNote = projectDir ? "（含当前项目区）" : "";
				return {
					content: [{
						type: "text",
						text: `memark：无匹配条目${scopeNote}。可换检索词重试；以下为 INDEX 摘要：\n${summary}`,
					}],
				};
			}

			const parts: string[] = [];
			for (const rel of uniq) {
				const abs = resolve(REPO, rel);
				if (!abs.startsWith(REPO + "/") && abs !== REPO) continue; // 防路径逃逸
				if (!existsSync(abs)) continue;
				let text = readFileSync(abs, "utf8");
				if (text.length > MAX_FILE_CHARS) {
					text = text.slice(0, MAX_FILE_CHARS) + "\n…[已截断，完整内容请直接读取该文件]";
				}
				parts.push(`===== ${rel} =====\n${text}`);
			}
			return { content: [{ type: "text", text: parts.join("\n\n") }] };
		},
	});

	// ---------- curator（P3） ----------
	registerCurator(pi);

	// ---------- 会话启动自动同步（折中方案） ----------
	// 只做后台静默 pull --ff-only：保障 recall 新鲜度；不 push、不修索引；
	// 任何失败（离线、分叉、无远端）静默跳过，不影响会话。完整同步仍用 /memory sync。
	pi.on("session_start", async () => {
		try {
			await git(pi, ["pull", "--ff-only", "--quiet"]);
		} catch {
			// 静默降级（方案 §11.4）：同步失败不阻塞会话
		}
	});

	// ---------- /memory 命令族 ----------
	pi.registerCommand("memory", {
		description: "memark 记忆库：status（默认）/ sync / review / approve <id> / reject <id> / forget <path> / revert",
		getArgumentCompletions: (prefix: string) => {
			const items: { value: string; label: string }[] = [];
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				for (const c of ["status", "sync", "review", "approve", "reject", "forget", "revert"]) {
					if (c.startsWith(prefix)) items.push({ value: c, label: c });
				}
			} else if (parts[0] === "approve" || parts[0] === "reject") {
				for (const id of listPendingIds()) {
					if (id.startsWith(parts[1] ?? "")) items.push({ value: `${parts[0]} ${id}`, label: id });
				}
			} else if (parts[0] === "forget") {
				for (const line of readIndex()) {
					const rel = pathFromIndexLine(line);
					if (rel && rel.startsWith(parts[1] ?? "")) items.push({ value: `forget ${rel}`, label: rel });
				}
			}
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			try {
				await handleMemoryCommand(pi, args ?? "", ctx as never);
			} catch (err) {
				ctx.ui.notify(`memark：操作失败：${(err as Error).message}`, "error");
			}
		},
	});

	// ---------- Gate（v0.4，未启用） ----------
	// agent_settled → 本地硬规则（工具输出/密钥/一次性内容直接丢弃）
	// → secret scan → Jev 并行判断（durable / user_grounded / ephemeral / sensitive…）
	// → pending 候选区。设计见 docs/记忆系统重构完整方案.md §7。
	// 在 Jev API key（TYPESAFE_API_KEY）与评测校准完成前不注册，避免产生未经验证的自动行为。
}
