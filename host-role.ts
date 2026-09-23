/** 当前 Pi 安装的本机角色：不进入共享 memory 仓库，也不使用 hostname 判定。 */
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const ROLE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,31}$/u;
const MAX_FILE_BYTES = 1024;

export function normalizeHostRole(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const role = value.trim();
	return ROLE.test(role) ? role : null;
}

function rolePath(): string {
	return join(getAgentDir(), "memark", "host-role.json");
}

export function readHostRole(): string | null {
	try {
		const file = rolePath();
		if (!lstatSync(join(getAgentDir(), "memark")).isDirectory()) return null;
		const stat = lstatSync(file);
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
		const data: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!data || typeof data !== "object" || Array.isArray(data)) return null;
		const record = data as Record<string, unknown>;
		return record.version === 1 ? normalizeHostRole(record.role) : null;
	} catch { return null; }
}

/** 仅显式用户输入可调用此写入；写入私有本机配置，不做 Git 操作。 */
export function saveHostRole(value: string): string {
	const role = normalizeHostRole(value);
	if (!role) throw new Error("角色须为 1–32 个字母、数字、空格、点、下划线或连字符，且不能以空格或符号开头");
	const file = rolePath();
	const dir = join(getAgentDir(), "memark");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (!lstatSync(dir).isDirectory()) throw new Error("本机配置目录不可用");
	try {
		if (lstatSync(file).isSymbolicLink()) throw new Error("拒绝覆盖符号链接角色文件");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	const temp = join(dir, `.host-role-${randomUUID()}.tmp`);
	try {
		writeFileSync(temp, JSON.stringify({ version: 1, role }) + "\n", { flag: "wx", mode: 0o600 });
		renameSync(temp, file);
	} finally {
		rmSync(temp, { force: true });
	}
	return role;
}
