/** Capture one local view; a concurrent writer falls back to an immutable Git commit. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LAYERS, PROJECTS_DIR, REPO, isFormalMemoryPath, resolveRepoPath } from "./repo";

export interface SnapshotScope {
	layers?: readonly string[];
	projects?: readonly string[] | "all";
}

export interface MemorySnapshot {
	read(rel: string): string | null;
	index(project?: string): string[];
	projects(): string[];
}

function localGit(args: string[]): string {
	return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", timeout: 5_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

function marker(): string {
	try { return readFileSync(join(REPO, ".git", "memark-mutation-version"), "utf8"); }
	catch { return ""; }
}

function head(): string | null {
	try { return localGit(["rev-parse", "--verify", "HEAD"]).trim(); }
	catch { return null; }
}

function wanted(rel: string, scope: SnapshotScope): boolean {
	if (rel === "INDEX.md") return true;
	const parts = rel.split("/");
	if (parts[0] === PROJECTS_DIR) {
		if (scope.projects !== undefined && scope.projects !== "all" && !scope.projects.includes(parts[1])) return false;
		return /^projects\/[^/]+\/INDEX\.md$/.test(rel) || isFormalMemoryPath(rel);
	}
	return (scope.layers ?? LAYERS).includes(parts[0]) && isFormalMemoryPath(rel);
}

function view(files: Map<string, string>): MemorySnapshot {
	return {
		read: (rel) => files.get(rel) ?? null,
		index: (project) => (files.get(project ? `${PROJECTS_DIR}/${project}/INDEX.md` : "INDEX.md") ?? "").split("\n"),
		projects: () => [...files.keys()].filter((rel) => /^projects\/[^/]+\/INDEX\.md$/.test(rel)).map((rel) => rel.split("/")[1]),
	};
}

function worktree(scope: SnapshotScope): Map<string, string> {
	const files = new Map<string, string>();
	function visit(rel: string): void {
		try {
			const { abs } = resolveRepoPath(rel);
			for (const entry of readdirSync(abs, { withFileTypes: true })) {
				const child = `${rel}/${entry.name}`;
				if (entry.isDirectory()) visit(child);
				else if (entry.isFile() && wanted(child, scope)) {
					try { files.set(child, readFileSync(resolveRepoPath(child).abs, "utf8")); }
					catch { /* One unreadable memory must not hide its siblings. */ }
				}
			}
		} catch { /* Missing or unsafe paths do not enter a recall snapshot. */ }
	}
	try { files.set("INDEX.md", readFileSync(resolveRepoPath("INDEX.md").abs, "utf8")); } catch { /* No local index. */ }
	for (const layer of scope.layers ?? LAYERS) visit(layer);
	if (scope.projects === undefined || scope.projects === "all") visit(PROJECTS_DIR);
	else for (const project of scope.projects) visit(`${PROJECTS_DIR}/${project}`);
	return files;
}

function committed(hash: string, scope: SnapshotScope): MemorySnapshot {
	const files = new Map<string, string>();
	for (const entry of localGit(["ls-tree", "-r", "-z", hash]).split("\0").filter(Boolean)) {
		const tab = entry.indexOf("\t");
		const rel = entry.slice(tab + 1);
		// Git symlinks must not be interpreted as memory, even while a checkout is changing.
		if (tab < 0 || (!entry.startsWith("100644 ") && !entry.startsWith("100755 ")) || !wanted(rel, scope)) continue;
		files.set(rel, localGit(["show", `${hash}:${rel}`]));
	}
	return view(files);
}

export function captureMemorySnapshot(scope: SnapshotScope = {}): MemorySnapshot {
	const lock = join(REPO, ".git", "memark-write.lock");
	const beforeMarker = marker();
	const beforeHead = head();
	if (existsSync(lock)) {
		if (!beforeHead) return view(new Map());
		return committed(beforeHead, scope);
	}
	const files = worktree(scope);
	// The marker detects failed/rolled-back mutations too, even when HEAD did not change.
	if (!existsSync(lock) && marker() === beforeMarker && head() === beforeHead) return view(files);
	const stable = head() ?? beforeHead;
	return stable ? committed(stable, scope) : view(new Map());
}
