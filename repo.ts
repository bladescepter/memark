/**
 * memark 共享层：记忆仓库路径、git 与协议脚本调用、基础读取工具。
 * 协议与校验逻辑跟数据走（memory 仓库 scripts/），本文件只做集成。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const REPO = resolve(process.env.MEMARK_REPO ?? join(homedir(), "DEV", "memory"));
export const LAYERS = ["identity", "principles", "preferences", "context", "knowledge"] as const;
export const PROJECTS_DIR = "projects";

/** 在记忆仓库上执行 git 命令 */
export async function git(pi: ExtensionAPI, args: string[]) {
	return pi.exec("git", ["-C", REPO, ...args]);
}

/** 运行 memory 仓库的协议脚本（python3 缺失时回退 python；脚本自身按位置定位仓库） */
export async function runRepoScript(pi: ExtensionAPI, script: string, args: string[] = []) {
	let last: Awaited<ReturnType<ExtensionAPI["exec"]>> | undefined;
	for (const py of ["python3", "python"]) {
		last = await pi.exec(py, [join(REPO, "scripts", script), ...args]);
		if (last.code !== 127 && last.code !== 9009) return last;
	}
	return last!;
}

/** 递归统计目录下 .md 记忆文件数（排除 README/INDEX） */
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

/** 读取 INDEX.md 全部行（默认根索引；传入 dir 可读项目区索引）；不存在时返回空数组 */
export function readIndex(dir: string = REPO): string[] {
	const p = join(dir, "INDEX.md");
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8").split("\n");
}
