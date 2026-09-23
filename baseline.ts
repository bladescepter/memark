/** 每轮运行环境 + 少量已审核的个人记忆；只读本地快照，不产生写入或网络请求。 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { platform } from "node:os";
import { readIndex, resolveRepoPath } from "./repo";
import { normalizeHostRole, readHostRole } from "./host-role";

const MAX_CHARS = 480;
const MAX_BYTES = 1100;
const MAX_FILE_BYTES = 16 * 1024;
const MAX_ITEM_CHARS = 110;
const LAYERS = ["identity", "principles", "preferences"] as const;
type Layer = (typeof LAYERS)[number];
const TYPES: Record<Layer, string> = { identity: "Identity", principles: "Principle", preferences: "Preference" };
const LIMITS: Record<Layer, number> = { identity: 1, principles: 4, preferences: 1 };

function cleanLine(value: string, max: number): string {
	const line = value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").replace(/\s+/g, " ").trim();
	return Array.from(line).slice(0, max).join("");
}

function readOsName(): string {
	const os = platform();
	if (os === "win32") return "Windows";
	if (os === "darwin") return "macOS";
	if (os !== "linux") return cleanLine(os, 40) || "未知";
	try {
		const release = readFileSync("/etc/os-release", "utf8");
		const raw = release.match(/^PRETTY_NAME=(.*)$/m)?.[1];
		if (raw) {
			const name = raw.startsWith('"') ? JSON.parse(raw) as unknown : raw;
			if (typeof name === "string" && cleanLine(name, 48)) return `Linux (${cleanLine(name, 48)})`;
		}
	} catch { /* 不依赖发行版文件；仍可识别 Linux。 */ }
	return "Linux";
}

export interface HostFacts {
	role?: string;
	os?: string;
}

/** 只把用户设置的本机角色和实时 OS 告诉 Agent。 */
export function hostContext(facts: HostFacts): string {
	const role = normalizeHostRole(facts.role) ?? "未确认";
	return [
		"【memark · 当前 Pi 进程运行环境】",
		`本机角色：${role}；操作系统：${cleanLine(facts.os || "未知", 48) || "未知"}。`,
		"角色未确认时勿根据 OS 或共享设备清单猜测；浏览器设备不是 Pi 的运行主机；远程命令另查执行目标。",
	].join("\n");
}

function scalar(raw: string | undefined): string | null {
	if (!raw) return null;
	try {
		const value: unknown = raw.startsWith('"') ? JSON.parse(raw) : raw;
		return typeof value === "string" ? value : null;
	} catch {
		return null;
	}
}

function reviewedSummary(text: string, layer: Layer): string | null {
	const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
	if (!front) return null;
	const field = (key: string) => front.match(new RegExp(`^${key}:\\s*(.*)$`, "m"))?.[1]?.trim();
	if (field("type") !== TYPES[layer] || field("status") !== "active" || field("reviewed") !== "true") return null;
	if (field("scope") === "project" || !["internal", "public"].includes(field("privacy") ?? "")) return null;
	const expiry = field("expires");
	if (expiry && expiry !== "null" && expiry <= new Date().toISOString().slice(0, 10)) return null;
	const title = scalar(field("title"));
	const description = scalar(field("description"));
	if (!title || !description) return null;
	const summary = `${title}：${description}`;
	if (Array.from(summary).length > MAX_ITEM_CHARS || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(summary)) return null;
	return summary;
}

function stableSummaries(): Record<Layer, string[]> {
	const result: Record<Layer, string[]> = { identity: [], principles: [], preferences: [] };
	const lines = readIndex();
	// 同一层内优先收纳安全、权限和备份类原则；不让索引字典序决定核心纪律。
	const priority = (line: string) => /—\s*principles\//.test(line) &&
		/(安全|权限|备份|隐私|密钥|security|permission|backup|privacy|secret)/i.test(line) ? 1 : 0;
	lines.sort((a, b) => priority(b) - priority(a));
	for (const line of lines) {
		const rel = line.match(/—\s*(\S+\.md)\s*$/)?.[1];
		if (!rel) continue;
		const parts = rel.split("/");
		if (parts.length !== 2 || !LAYERS.includes(parts[0] as Layer)) continue;
		const layer = parts[0] as Layer;
		if (result[layer].length >= LIMITS[layer]) continue;
		try {
			const { abs } = resolveRepoPath(rel);
			if (!existsSync(abs)) continue;
			const stats = statSync(abs);
			if (!stats.isFile() || stats.size > MAX_FILE_BYTES) continue;
			const summary = reviewedSummary(readFileSync(abs, "utf8"), layer);
			if (summary) result[layer].push(summary);
		} catch { /* 不可读、不安全或格式不符的记忆不注入。 */ }
	}
	return result;
}

function fits(text: string): boolean {
	return Array.from(text).length <= MAX_CHARS && Buffer.byteLength(text, "utf8") <= MAX_BYTES;
}

/** 每次调用重新读取本机环境和本地已审核索引；不注入会话历史，不联网。 */
export function buildBaselineContext(): string {
	let os = "未知";
	try { os = readOsName(); } catch { /* 操作系统无法读取时标未知。 */ }
	const host = hostContext({ role: readHostRole() ?? undefined, os });
	if (!fits(host)) return hostContext({ os: "未知" });
	const selected: Record<Layer, string[]> = { identity: [], principles: [], preferences: [] };
	try {
		const available = stableSummaries();
		// 先留出偏好和身份空间，再纳入原则；输出时恢复分层顺序。
		for (const layer of ["identity", "preferences", "principles"] as const) {
			for (const summary of available[layer]) {
				selected[layer].push(`- ${summary}`);
				const draft = [host, "【已审核个人记忆摘要（本地快照）】", ...LAYERS.flatMap((l) => selected[l])].join("\n");
				if (!fits(draft)) selected[layer].pop();
			}
		}
	} catch { /* 记忆仓库缺失、索引损坏等不会妨碍主机识别和正常对话。 */ }
	const lines = LAYERS.flatMap((layer) => selected[layer]);
	if (lines.length === 0) return host;
	return [host, "【已审核个人记忆摘要（本地快照）】", ...lines].join("\n");
}
