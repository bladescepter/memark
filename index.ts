/**
 * memark — memory + markdown，pi 编码代理的长期记忆扩展。
 *
 * 当前版本：
 * - memark_recall：每个会话第一次实际查找时尝试同步；个人区 + 当前项目，支持显式跨项目
 * - memark_remember：临时校验 → 修改预览 → 用户确认 → 精确提交；失败降级 pending
 * - /memory：status / sync / review / approve / reject / maintain / forget / revert / host
 *
 * - 基线注入：每轮注入本机角色/实时 OS 与已审核个人记忆摘要（只读本地快照）
 * Gate 尚未启用；Gate 只能产出 pending，不能正式写入。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
	PROJECTS_DIR,
	REPO,
	git,
	readIndex,
	resolveRepoPath,
	unsafeWorktreeChanges,
	withRepoMutation,
} from "./repo";
import { handleMemoryCommand, listPendingIds, registerCurator } from "./curator";
import { buildBaselineContext } from "./baseline";
import { readHostRole, saveHostRole } from "./host-role";

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2000;
const MAX_SCAN_CHARS_PER_FILE = 20_000;
const RECALL_SYNC_TIMEOUT_MS = 5_000;

function validProjectName(name: string): boolean {
	return /^[\w\u4e00-\u9fff.-]+$/.test(name) && name !== "." && name !== ".." && !/[. ]$/.test(name) &&
		!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}

function projectDirByName(name: string): string | null {
	if (!validProjectName(name)) return null;
	try {
		const dir = resolveRepoPath(`${PROJECTS_DIR}/${name}`).abs;
		return existsSync(join(dir, "INDEX.md")) ? dir : null;
	} catch {
		return null;
	}
}

/** 从 cwd 向父目录查找第一个有对应项目记忆的目录名。 */
function projectDirFor(cwd?: string): string | null {
	const explicit = process.env.MEMARK_PROJECT?.trim();
	if (explicit) return projectDirByName(explicit);
	if (!cwd) return null;
	let current = resolve(cwd);
	while (true) {
		const match = projectDirByName(basename(current));
		if (match) return match;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function allProjectIndexLines(): string[] {
	const root = join(REPO, PROJECTS_DIR);
	if (!existsSync(root)) return [];
	const lines: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || !validProjectName(entry.name)) continue;
		lines.push(...readIndex(join(root, entry.name)));
	}
	return lines;
}

/** 从 INDEX 条目行解析记忆文件相对路径。 */
export function pathFromIndexLine(line: string): string | null {
	const match = line.match(/—\s*(\S+\.md)\s*$/);
	return match ? match[1] : null;
}

/** 解析 INDEX 条目行。 */
function parseIndexLine(line: string): { title: string; description: string; tags: string } | null {
	const match = line.match(/^- \[[^\]]+\]\s+(.*)$/);
	if (!match) return null;
	const pathMatch = match[1].match(/—\s*(\S+\.md)\s*$/);
	if (!pathMatch) return null;
	const body = match[1].slice(0, pathMatch.index ?? 0).trimEnd();
	const parts = body.split(/\s+—\s+/);
	if (parts.length < 2) return null;
	const tags = (parts.length >= 3 ? parts[parts.length - 1] : "").replace(/^tags:\s*/, "");
	return { title: parts[0] ?? "", description: parts[parts.length - 2] ?? "", tags };
}

function queryTokens(query: string): string[] {
	return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

/** 标题 > 描述 > 标签 > 路径；缺失的检索词不加分。 */
export function matchIndexLines(lines: string[], query: string): string[] {
	const tokens = queryTokens(query);
	if (tokens.length === 0) return [];
	const phrase = tokens.join(" ");
	const scored: { path: string; score: number; hits: number; order: number }[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const rel = pathFromIndexLine(line);
		if (!rel) continue;
		const parsed = parseIndexLine(line);
		const low = line.toLocaleLowerCase();
		let score = 0;
		let hits = 0;
		if (parsed) {
			const title = parsed.title.toLocaleLowerCase();
			const description = parsed.description.toLocaleLowerCase();
			const tags = parsed.tags.toLocaleLowerCase();
			for (const token of tokens) {
				if (title.includes(token)) {
					score += 3;
					hits++;
				} else if (description.includes(token)) {
					score += 2;
					hits++;
				} else if (tags.includes(token)) {
					score += 1;
					hits++;
				} else if (rel.toLocaleLowerCase().includes(token)) {
					score += 0.5;
					hits++;
				}
			}
		} else {
			hits = tokens.filter((token) => low.includes(token)).length;
			score = hits;
		}
		if (hits === 0) continue;
		if (tokens.length > 1 && hits === tokens.length) score += 2;
		if (phrase && low.includes(phrase)) score += 2;
		scored.push({ path: rel, score, hits, order: i });
	}
	return scored
		.sort((a, b) => b.score - a.score || b.hits - a.hits || a.order - b.order)
		.map((item) => item.path)
		.filter((path, index, all) => all.indexOf(path) === index);
}

function safeReadMemory(rel: string): string | null {
	try {
		const { abs } = resolveRepoPath(rel);
		if (!existsSync(abs)) return null;
		return readFileSync(abs, "utf8");
	} catch {
		return null;
	}
}

function isExpired(text: string): boolean {
	const expires = text.match(/^expires:\s*(\d{4}-\d{2}-\d{2})$/m)?.[1];
	return Boolean(expires && expires < new Date().toISOString().slice(0, 10));
}

function withoutExpiredEntries(lines: string[]): string[] {
	return lines.filter((line) => {
		const rel = pathFromIndexLine(line);
		if (!rel) return true;
		const text = safeReadMemory(rel);
		return Boolean(text && !isExpired(text));
	});
}

function fullTextMatches(lines: string[], query: string, excluded: Set<string>): string[] {
	const tokens = queryTokens(query);
	const scored: { path: string; score: number; order: number }[] = [];
	const paths = lines.map(pathFromIndexLine).filter((path): path is string => Boolean(path));
	for (let i = 0; i < paths.length; i++) {
		const path = paths[i];
		if (excluded.has(path)) continue;
		const text = safeReadMemory(path);
		if (!text || isExpired(text)) continue;
		const low = text.slice(0, MAX_SCAN_CHARS_PER_FILE).toLocaleLowerCase();
		const hits = tokens.filter((token) => low.includes(token)).length;
		if (hits > 0) scored.push({ path, score: hits + (hits === tokens.length && tokens.length > 1 ? 1 : 0), order: i });
	}
	return scored.sort((a, b) => b.score - a.score || a.order - b.order).map((item) => item.path);
}

function truncateOutput(text: string): string {
	const lines = text.split("\n");
	const kept: string[] = [];
	let bytes = 0;
	let truncated = false;
	for (const line of lines) {
		const nextBytes = Buffer.byteLength(line, "utf8") + 1;
		if (kept.length >= MAX_OUTPUT_LINES || bytes + nextBytes > MAX_OUTPUT_BYTES) {
			truncated = true;
			break;
		}
		kept.push(line);
		bytes += nextBytes;
	}
	return kept.join("\n") + (truncated ? "\n…[输出已按 50KB/2000 行上限截断；需要时请直接读取对应文件]" : "");
}

export default function (pi: ExtensionAPI) {
	let rolePrompted = false;
	// 首次交互才请用户声明当前 Pi 主机的角色；无 UI 或取消时不猜测、不保存。
	// 系统提示仅在本轮有效，不往会话历史或共享仓库写入动态主机信息。
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			if (!readHostRole() && ctx.hasUI && !rolePrompted) {
				rolePrompted = true;
				try {
					const input = await ctx.ui.input("memark：首次使用，请设置当前 Pi 运行机器的角色", "例如 VPS、工作电脑、家庭电脑、Linux 笔记本");
					if (input !== undefined) {
						saveHostRole(input);
						ctx.ui.notify("memark：本机角色已保存；可用 /memory host 修改。", "info");
					}
				} catch (err) {
					ctx.ui.notify(`memark：角色未保存：${(err as Error).message}。请用 /memory host set <角色> 重试。`, "warning");
				}
			}
			const context = buildBaselineContext();
			return { systemPrompt: `${event.systemPrompt}\n\n${context}` };
		} catch {
			// 基线故障不影响正常对话，recall/remember 仍独立可用。
			return;
		}
	});

	let firstRecallSync: Promise<string | null> | null = null;

	async function syncBeforeFirstRecall(): Promise<string | null> {
		if (firstRecallSync) return firstRecallSync;
		firstRecallSync = withRepoMutation(async () => {
			if (!existsSync(join(REPO, ".git"))) return `记忆仓库不存在或尚未初始化：${REPO}`;
			const dirty = await unsafeWorktreeChanges(pi);
			if (dirty.length > 0) return `记忆仓库有未处理修改，未自动下载最新版本：${dirty.map((item) => item.path).join(", ")}`;
			const result = await git(pi, ["pull", "--ff-only", "--quiet"], { timeout: RECALL_SYNC_TIMEOUT_MS - 500 });
			return result.code === 0 ? null : `自动同步失败，当前使用本地记忆：${(result.stderr || result.stdout).trim()}`;
		}, { waitMs: 500 }).catch((err) => `自动同步失败，当前使用本地记忆：${(err as Error).message}`);
		return firstRecallSync;
	}

	pi.registerTool({
		name: "memark_recall",
		label: "Memory Recall",
		description:
			"检索 Markdown 长期记忆库。每个会话第一次调用时先尝试在 5 秒内下载最新版本；失败则使用本地快照。" +
			"默认范围为个人区加当前项目；all_projects=true 时显式检索全部项目。先匹配索引，再以正文关键词补充。" +
			"过期记忆不会返回。最多返回 10 个文件，总输出不超过 50KB/2000 行。",
		promptSnippet: "Search reviewed long-term memories relevant to the current task",
		promptGuidelines: [
			"Use memark_recall when prior preferences, decisions, work disciplines, or project conventions would change how you approach the task.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "检索词（可用空格分隔多个关键词）" }),
			max_files: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "最多返回文件数，默认 3" })),
			all_projects: Type.Optional(Type.Boolean({ description: "明确要求跨项目检索时设为 true" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				if (signal?.aborted) throw new Error("操作已取消");
				const syncWarning = await syncBeforeFirstRecall();
				const projectDir = projectDirFor(ctx?.cwd);
				const personalLines = readIndex();
				const projectLines = params.all_projects
					? allProjectIndexLines()
					: projectDir ? readIndex(projectDir) : [];
				const lines = withoutExpiredEntries([...personalLines, ...projectLines]);
				const prefix = syncWarning ? `⚠ ${syncWarning}\n\n` : "";
				if (lines.every((line) => !line.includes(".md"))) {
					return { content: [{ type: "text", text: `${prefix}memark：没有可用的正式记忆索引（${REPO}）。` }], details: {} };
				}

				const maxFiles = params.max_files ?? 3;
				const ranked = matchIndexLines(lines, params.query);
				const combined = [...ranked];
				if (combined.length < maxFiles) {
					combined.push(...fullTextMatches(lines, params.query, new Set(combined)));
				}
				const selected = [...new Set(combined)].slice(0, maxFiles);
				const parts: string[] = [];
				for (const rel of selected) {
					const text = safeReadMemory(rel);
					if (!text || isExpired(text)) continue;
					parts.push(`===== ${rel} =====\n${text}`);
				}
				if (parts.length === 0) {
					const summary = lines.filter((line) => line.includes(".md")).slice(0, 40).join("\n");
					return {
						content: [{ type: "text", text: truncateOutput(`${prefix}memark：无匹配条目。可换检索词重试；INDEX 摘要：\n${summary}`) }],
						details: {},
					};
				}
				return { content: [{ type: "text", text: truncateOutput(prefix + parts.join("\n\n")) }], details: {} };
			} catch (err) {
				return {
					content: [{
						type: "text",
						text: `memark：查找失败（${(err as Error).message}）。请继续当前任务；必要时用 read/grep 直接读取 ${REPO}。`,
					}],
					details: {},
				};
			}
		},
	});

	registerCurator(pi);

	pi.registerCommand("memory", {
		description: "memark：status / sync / review / approve / reject / maintain / forget / revert / host",
		getArgumentCompletions: (prefix: string) => {
			const items: { value: string; label: string }[] = [];
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				for (const command of ["status", "sync", "review", "approve", "reject", "maintain", "forget", "revert", "host"]) {
					if (command.startsWith(prefix)) items.push({ value: command, label: command });
				}
			} else if (parts[0] === "host") {
				if ("set".startsWith(parts[1] ?? "")) items.push({ value: "host set ", label: "host set <角色>" });
			} else if (parts[0] === "approve" || parts[0] === "reject") {
				for (const id of listPendingIds()) {
					if (id.startsWith(parts[1] ?? "")) items.push({ value: `${parts[0]} ${id}`, label: id });
				}
			} else if (parts[0] === "forget") {
				for (const line of [...readIndex(), ...allProjectIndexLines()]) {
					const rel = pathFromIndexLine(line);
					if (rel && rel.startsWith(parts[1] ?? "")) items.push({ value: `forget ${rel}`, label: rel });
				}
			}
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			try {
				const command = (args ?? "").trim();
				if (command === "host") {
					ctx.ui.notify(`memark：本机角色：${readHostRole() ?? "未确认"}。修改：/memory host set <角色>；操作系统每轮实时识别。`, "info");
					return;
				}
				if (command === "host set" || command.startsWith("host set ")) {
					const role = saveHostRole(command.slice("host set".length));
					ctx.ui.notify(`memark：本机角色已设为 ${role}（仅本机）；下一轮开始生效。`, "info");
					return;
				}
				if (command.startsWith("host ")) {
					ctx.ui.notify("用法：/memory host 或 /memory host set <角色>", "warning");
					return;
				}
				await handleMemoryCommand(pi, args ?? "", ctx as never);
			} catch (err) {
				ctx.ui.notify(`memark：操作失败：${(err as Error).message}`, "error");
			}
		},
	});

	// Gate 尚未启用：须先完成 200–500 轮人工标注评测，再接 agent_settled；只能写 pending。
}
