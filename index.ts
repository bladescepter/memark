/**
 * memark — memory + markdown
 * pi 编码代理的长期记忆扩展。
 *
 * v0.1（当前）
 *   - memark_recall 工具：按任务检索记忆仓库（INDEX.md 路由 → 读取正文）
 *   - /memory 命令：仓库状态（索引条目、分层计数、pending、git 状态）
 *
 * v0.2+（计划，见 docs/记忆系统重构完整方案.md §7–8）
 *   - Gate：agent_settled → 本地硬规则 + secret scan → Jev 结构化判断 → pending 入队
 *   - curator：候选提炼、去重、diff、用户批准（ctx.ui.confirm）后提交 Git
 *   - 基线注入：before_agent_start 注入 ≤600 tokens 稳定基线
 *
 * 记忆仓库路径：环境变量 MEMARK_REPO，默认 ~/DEV/memory。
 * 仓库协议（README 路由权威、五层目录、frontmatter）由记忆仓库自身承载。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const REPO = resolve(process.env.MEMARK_REPO ?? join(homedir(), "DEV", "memory"));
const LAYERS = ["identity", "principles", "preferences", "context", "knowledge"] as const;
const MAX_FILE_CHARS = 4000;

/** 递归统计目录下 .md 文件数 */
function countMd(dir: string): number {
	if (!existsSync(dir)) return 0;
	let n = 0;
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) n += countMd(p);
		else if (e.name.endsWith(".md")) n += 1;
	}
	return n;
}

/** 读取 INDEX.md 全部行；仓库未初始化时返回空数组 */
function readIndex(): string[] {
	const p = join(REPO, "INDEX.md");
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8").split("\n");
}

/** 从 INDEX 条目行解析记忆文件相对路径（行尾最后一个 " — " 之后、以 .md 结尾的部分） */
function pathFromIndexLine(line: string): string | null {
	const m = line.match(/—\s*(\S+\.md)\s*$/);
	return m ? m[1] : null;
}

export default function (pi: ExtensionAPI) {
	// ---------- recall 工具 ----------
	pi.registerTool({
		name: "memark_recall",
		label: "Memory Recall",
		description:
			"检索个人长期记忆库（memark，Markdown 仓库）并返回与当前任务相关的记忆条目。" +
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
		async execute(_toolCallId, params) {
			const lines = readIndex();
			if (lines.length === 0) {
				return {
					content: [{
						type: "text",
						text:
							`memark：记忆仓库未初始化（${REPO} 缺少 INDEX.md）。` +
							"请正常继续当前任务；记忆库建立协议见 memark 扩展仓库 docs/记忆系统重构完整方案.md。",
					}],
				};
			}

			const tokens = params.query.split(/\s+/).filter(Boolean);
			const lowerQuery = params.query.toLowerCase();
			const matched: string[] = [];
			for (const line of lines) {
				if (!line.includes(".md")) continue;
				const lower = line.toLowerCase();
				const hit =
					tokens.some((t) => lower.includes(t.toLowerCase())) ||
					(tokens.length > 1 && lower.includes(lowerQuery));
				if (!hit) continue;
				const rel = pathFromIndexLine(line);
				if (rel) matched.push(rel);
			}

			const uniq = [...new Set(matched)].slice(0, params.max_files ?? 3);
			if (uniq.length === 0) {
				const summary = lines.filter((l) => l.includes(".md")).slice(0, 40).join("\n");
				return {
					content: [{
						type: "text",
						text: `memark：无匹配条目。可换检索词重试；以下为 INDEX 摘要：\n${summary}`,
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

	// ---------- /memory 命令 ----------
	pi.registerCommand("memory", {
		description: "memark 记忆库状态（/memory 或 /memory status）",
		handler: async (_args, ctx) => {
			if (!existsSync(REPO)) {
				ctx.ui.notify(
					`memark：记忆仓库不存在（${REPO}）。设置 MEMARK_REPO 环境变量，或按协议创建 memory 仓库。`,
					"warning",
				);
				return;
			}
			const entries = readIndex().filter((l) => l.includes(".md")).length;
			const pending = countMd(join(REPO, "pending"));
			const counts = LAYERS.map((l) => `${l}: ${countMd(join(REPO, l))}`).join("  ");

			const { stdout: st, code } = await pi.exec("git", ["-C", REPO, "status", "--porcelain"]);
			const dirty = code === 0 ? st.split("\n").filter(Boolean).length : -1;
			const { stdout: br } = await pi.exec("git", ["-C", REPO, "branch", "--show-current"]);
			const gitInfo =
				dirty === -1 ? "非 git 仓库" : `${br.trim() || "?"}${dirty > 0 ? `（${dirty} 处未提交）` : "（干净）"}`;

			ctx.ui.notify(
				`memark @ ${REPO}\n索引条目: ${entries}  pending: ${pending}  git: ${gitInfo}\n${counts}`,
				"info",
			);
		},
	});

	// ---------- Gate（v0.2，未启用） ----------
	// agent_settled → 本地硬规则（工具输出/密钥/一次性内容直接丢弃）
	// → secret scan → Jev 并行判断（durable / user_grounded / ephemeral / sensitive…）
	// → pending 候选区。设计见 docs/记忆系统重构完整方案.md §7。
	// 在 Jev API key（TYPESAFE_API_KEY）与评测校准完成前不注册，避免产生未经验证的自动行为。
}
