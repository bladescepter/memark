/**
 * memark 共享层：记忆仓库路径、安全路径、git、协议脚本与写入串行化。
 * 协议与校验逻辑跟数据走（memory 仓库 scripts/），本文件只做 pi 集成。
 */
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}

export const REPO = resolve(expandHome(process.env.MEMARK_REPO ?? join(homedir(), "DEV", "memory")));
export const LAYERS = ["identity", "principles", "preferences", "context", "knowledge"] as const;
export const PROJECTS_DIR = "projects";
const PROJECT_CATEGORIES = new Set(["decisions", "topics", "incidents", "handoffs"]);

interface ExecOptions {
	signal?: AbortSignal;
	timeout?: number;
}

/** 在记忆仓库上执行 git 命令。 */
export async function git(pi: ExtensionAPI, args: string[], options: ExecOptions = {}) {
	return pi.exec("git", ["-C", REPO, ...args], options);
}

/** 运行 memory 仓库的协议脚本（python3 缺失时回退 python）。 */
export async function runRepoScript(
	pi: ExtensionAPI,
	script: string,
	args: string[] = [],
	options: ExecOptions = {},
) {
	let last: Awaited<ReturnType<ExtensionAPI["exec"]>> | undefined;
	for (const py of ["python3", "python"]) {
		last = await pi.exec(py, [join(REPO, "scripts", script), ...args], options);
		if (last.code !== 127 && last.code !== 9009) return last;
	}
	return last!;
}

/**
 * 把仓库相对路径解析为安全绝对路径。
 * 同时拒绝绝对路径、..、空路径和路径中的符号链接，兼容 POSIX/Windows。
 */
export function resolveRepoPath(input: string, options: { allowRoot?: boolean } = {}): {
	rel: string;
	abs: string;
} {
	if (typeof input !== "string" || input.includes("\0")) throw new Error("路径无效");
	const slash = input.trim().replace(/\\/g, "/");
	if (!slash || slash === ".") {
		if (options.allowRoot) return { rel: "", abs: REPO };
		throw new Error("路径不能为空");
	}
	if (isAbsolute(input) || win32.isAbsolute(input) || slash.startsWith("/")) {
		throw new Error(`只允许记忆仓库内的相对路径：${input}`);
	}
	const parts = slash.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) {
		throw new Error(`路径不得包含空段、. 或 ..：${input}`);
	}
	const abs = resolve(REPO, ...parts);
	const delta = relative(REPO, abs);
	if (!delta || delta === ".." || delta.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(delta)) {
		throw new Error(`路径超出记忆仓库：${input}`);
	}

	let current = REPO;
	for (const part of parts) {
		current = join(current, part);
		if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
			throw new Error(`记忆路径中不允许符号链接：${input}`);
		}
	}
	return { rel: parts.join("/"), abs };
}

/** 判断路径是否为正式记忆文件，而不是 README/INDEX 或系统管理区。 */
export function isFormalMemoryPath(input: string): boolean {
	let rel: string;
	try {
		rel = resolveRepoPath(input).rel;
	} catch {
		return false;
	}
	const parts = rel.split("/");
	const file = parts[parts.length - 1];
	if (!file.endsWith(".md") || file === "README.md" || file === "INDEX.md") return false;
	if ((LAYERS as readonly string[]).includes(parts[0])) return parts.length === 2 || parts.length === 3;
	if (parts[0] !== PROJECTS_DIR || parts.length < 3) return false;
	return parts.length === 3 || (parts.length === 4 && PROJECT_CATEGORIES.has(parts[2]));
}

/** 把标题转换为跨平台安全文件名。 */
export function filenameFromTitle(title: string): string {
	let name = title
		.normalize("NFC")
		.trim()
		.replace(/\s+/g, "")
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
		.replace(/-+/g, "-")
		.replace(/[. ]+$/g, "");
	if (!name || name === "." || name === "..") throw new Error("title 无法生成合法文件名");
	if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `记忆-${name}`;
	if (Buffer.byteLength(name, "utf8") > 180) throw new Error("title 过长，无法生成稳定文件名");
	return name;
}

/** 递归统计目录下 .md 文件数（排除 README/INDEX）。 */
export function countMd(dir: string): number {
	if (!existsSync(dir)) return 0;
	let n = 0;
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) n += countMd(p);
		else if (e.name.endsWith(".md") && e.name !== "README.md" && e.name !== "INDEX.md") n += 1;
	}
	return n;
}

/** 读取 INDEX.md 全部行；不存在时返回空数组。 */
export function readIndex(dir: string = REPO): string[] {
	const p = join(dir, "INDEX.md");
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8").split("\n");
}

export interface WorktreeChange {
	status: string;
	path: string;
}

/** 读取未提交改动；-z 避免中文路径被引号转义。 */
export async function worktreeChanges(pi: ExtensionAPI): Promise<WorktreeChange[]> {
	const result = await git(pi, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	if (result.code !== 0) throw new Error(`无法读取 git 状态：${(result.stderr || result.stdout).trim()}`);
	const records = result.stdout.split("\0").filter(Boolean);
	const changes: WorktreeChange[] = [];
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		const status = record.slice(0, 2);
		const path = record.slice(3).replace(/\\/g, "/");
		changes.push({ status, path });
		if (status.includes("R") || status.includes("C")) {
			const oldPath = records[++i];
			if (oldPath) changes.push({ status, path: oldPath.replace(/\\/g, "/") });
		}
	}
	return changes;
}

/** pending 候选允许作为本地未跟踪文件存在；其余改动会阻止自动写入。 */
export async function unsafeWorktreeChanges(pi: ExtensionAPI): Promise<WorktreeChange[]> {
	return (await worktreeChanges(pi)).filter(
		(change) => !(change.status === "??" && change.path.startsWith("pending/")),
	);
}

/** 精确恢复一组文件，不触碰用户的其他路径。 */
export interface FileSnapshot {
	rel: string;
	existed: boolean;
	content?: Buffer;
}

export function snapshotFiles(paths: string[]): FileSnapshot[] {
	return [...new Set(paths)].map((rel) => {
		const { abs } = resolveRepoPath(rel);
		return existsSync(abs)
			? { rel, existed: true, content: readFileSync(abs) }
			: { rel, existed: false };
	});
}

export function restoreSnapshots(snapshots: FileSnapshot[]): void {
	for (const snapshot of snapshots) {
		const { abs } = resolveRepoPath(snapshot.rel);
		if (snapshot.existed) {
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, snapshot.content!);
		} else if (existsSync(abs)) {
			rmSync(abs, { force: true });
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

let mutationTail: Promise<void> = Promise.resolve();

/**
 * 串行化本进程写入，并用 .git/memark-write.lock 防止本机多个 pi 进程同时改仓库。
 */
export async function withRepoMutation<T>(
	fn: () => Promise<T>,
	options: { signal?: AbortSignal; waitMs?: number } = {},
): Promise<T> {
	let releaseQueue!: () => void;
	const turn = new Promise<void>((resolvePromise) => {
		releaseQueue = resolvePromise;
	});
	const previous = mutationTail;
	mutationTail = previous.then(() => turn, () => turn);
	await previous;

	const lockDir = join(REPO, ".git", "memark-write.lock");
	const started = Date.now();
	const waitMs = options.waitMs ?? 10_000;
	let locked = false;
	try {
		while (!locked) {
			if (options.signal?.aborted) throw new Error("操作已取消");
			try {
				mkdirSync(lockDir);
				locked = true;
				writeFileSync(join(lockDir, "owner"), `${process.pid}\n${new Date().toISOString()}\n`);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "EEXIST") throw err;
				// 仅清理由已退出进程遗留且超过 30 分钟的本机锁；活跃确认窗口不误删。
				try {
					let ownerAlive = false;
					const owner = Number(readFileSync(join(lockDir, "owner"), "utf8").split(/\s+/)[0]);
					if (Number.isInteger(owner) && owner > 0) {
						try {
							process.kill(owner, 0);
							ownerAlive = true;
						} catch (ownerError) {
							ownerAlive = (ownerError as NodeJS.ErrnoException).code === "EPERM";
						}
					}
					if (!ownerAlive && Date.now() - statSync(lockDir).mtimeMs > 30 * 60_000) {
						rmSync(lockDir, { recursive: true, force: true });
						continue;
					}
				} catch {
					// 锁恰好被其他进程释放，继续重试。
				}
				if (Date.now() - started >= waitMs) throw new Error("另一项记忆写入仍在进行，请稍后重试");
				await sleep(100);
			}
		}
		return await fn();
	} finally {
		if (locked) rmSync(lockDir, { recursive: true, force: true });
		releaseQueue();
	}
}
