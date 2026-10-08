/** Local-only download scheduling; never repairs, commits, or pushes memory. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { REPO, git, unsafeWorktreeChanges, withRepoMutation } from "./repo";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const STATE_FILE = join(REPO, ".git", "memark-sync-state.json");
type Outcome = "success" | "dirty" | "timeout" | "network" | "auth" | "diverged" | "unavailable" | "cancelled";
type Stage = "status" | "pull" | "state";
interface SyncState {
	version: 1;
	lastSuccess: number;
	nextAttempt: number;
	failures: number;
	outcome: Outcome;
	stage: Stage;
	durationMs: number;
}
const OUTCOMES = new Set<Outcome>(["success", "dirty", "timeout", "network", "auth", "diverged", "unavailable", "cancelled"]);

export function syncIntervalMs(): number {
	const value = Number(process.env.MEMARK_SYNC_INTERVAL_MS);
	return Number.isFinite(value) && value >= MINUTE && value <= 24 * HOUR ? value : HOUR;
}

export function readSyncState(): SyncState | null {
	try {
		const stat = lstatSync(STATE_FILE);
		if (!stat.isFile() || stat.size > 4096) return null;
		const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as SyncState;
		if (state.version !== 1 || !OUTCOMES.has(state.outcome) || !["status", "pull", "state"].includes(state.stage)) return null;
		if (![state.lastSuccess, state.nextAttempt, state.failures, state.durationMs].every((n) => Number.isSafeInteger(n) && n >= 0)) return null;
		if (state.lastSuccess > 8.64e15 || state.nextAttempt > 8.64e15 || state.failures > 100) return null;
		return state;
	} catch { return null; }
}

/** Call only while holding the repository mutation lock. No stderr or credentials are persisted. */
function saveState(state: SyncState): void {
	if (!lstatSync(join(REPO, ".git")).isDirectory()) throw new Error("Git directory unavailable");
	if (existsSync(STATE_FILE) && !lstatSync(STATE_FILE).isFile()) throw new Error("Unsafe sync state file");
	const temp = `${STATE_FILE}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(state) + "\n", { flag: "wx", mode: 0o600 });
		renameSync(temp, STATE_FILE);
	} finally { rmSync(temp, { force: true }); }
}

/** A successful manual download also refreshes every session's shared freshness state. */
export function recordSyncSuccess(now = Date.now(), durationMs = 0): void {
	saveState({ version: 1, lastSuccess: now, nextAttempt: 0, failures: 0, outcome: "success", stage: "pull", durationMs });
}

function classify(text: string): Outcome {
	if (/authentication|permission denied|could not read username|terminal prompts disabled|publickey|401|403/i.test(text)) return "auth";
	if (/fast-forward|divergent|unrelated histories|local changes.*overwritten|would be overwritten/i.test(text)) return "diverged";
	return "network";
}

interface SchedulerOptions {
	intervalMs?: number;
	timeoutMs?: number;
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
	onIdle?: () => void;
}

/** One coordinator per repository in a Pi/pi-web process; disk state deduplicates other processes. */
export class SyncScheduler {
	private owners = new Map<symbol, ExtensionAPI>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private controller: AbortController | null = null;
	private task: Promise<void> | null = null;
	private busyUntil = 0;
	private readonly interval: number;
	private readonly now: () => number;
	private readonly setTimer: NonNullable<SchedulerOptions["setTimer"]>;
	private readonly clearTimer: NonNullable<SchedulerOptions["clearTimer"]>;

	constructor(private readonly options: SchedulerOptions = {}) {
		this.interval = options.intervalMs ?? syncIntervalMs();
		this.now = options.now ?? Date.now;
		this.setTimer = options.setTimer ?? setTimeout;
		this.clearTimer = options.clearTimer ?? clearTimeout;
	}

	attach(pi: ExtensionAPI): () => Promise<void> {
		const token = Symbol("memark-sync-owner");
		this.owners.set(token, pi);
		if (!this.task) this.schedule(0);
		let stopped = false;
		return async () => {
			if (stopped) return;
			stopped = true;
			this.owners.delete(token);
			// An in-flight exec belongs to its original extension runtime, even if other owners survive.
			const ownsTask = this.activeOwner === token || this.owners.size === 0;
			if (ownsTask) this.controller?.abort();
			if (this.owners.size === 0 && this.timer) { this.clearTimer(this.timer); this.timer = null; }
			if (ownsTask) await this.task;
			if (this.owners.size === 0) this.options.onIdle?.();
		};
	}

	private activeOwner: symbol | null = null;

	async cancelDownload(): Promise<void> {
		this.controller?.abort();
		await this.task;
	}

	private dueAt(state: SyncState | null): number {
		const now = this.now();
		const success = state && state.lastSuccess <= now ? state.lastSuccess : 0;
		const retry = state && state.nextAttempt <= now + 24 * HOUR ? state.nextAttempt : 0;
		return Math.max(success ? success + this.interval : 0, retry, this.busyUntil);
	}

	private schedule(delay: number): void {
		if (this.timer) this.clearTimer(this.timer);
		if (!this.owners.size) return;
		this.timer = this.setTimer(() => { this.timer = null; void this.check(); }, Math.max(0, delay));
		this.timer.unref?.();
	}

	/** Starts detached work and consumes all errors. Exposed for deterministic fixture tests. */
	check(): Promise<void> {
		if (this.task) return this.task;
		if (!this.owners.size) return Promise.resolve();
		const entry = this.owners.entries().next().value!;
		this.activeOwner = entry[0];
		const controller = new AbortController();
		this.controller = controller;
		this.task = this.download(entry[1], controller.signal).catch(() => {
			// Missing repository or unwritable local state must not create a tight retry loop.
			this.busyUntil = this.now() + MINUTE;
		}).finally(() => {
			this.task = null;
			this.controller = null;
			this.activeOwner = null;
			if (this.owners.size) this.schedule(Math.max(MINUTE, this.dueAt(readSyncState()) - this.now()));
			else this.options.onIdle?.();
		});
		return this.task;
	}

	private async download(pi: ExtensionAPI, ownerSignal: AbortSignal): Promise<void> {
		if (this.now() < this.dueAt(readSyncState())) return;
		if (!existsSync(join(REPO, ".git"))) { this.busyUntil = this.now() + HOUR; return; }
		const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 60_000);
		const signal = AbortSignal.any([ownerSignal, timeout]);
		const started = this.now();
		const deadline = Date.now() + (this.options.timeoutMs ?? 60_000);
		const execOptions = () => { signal.throwIfAborted(); return { signal, timeout: Math.max(1, deadline - Date.now()) }; };
		await withRepoMutation(async () => {
			// Recheck after acquiring the cross-process lock: another session may already have downloaded.
			const previous = readSyncState();
			if (this.now() < this.dueAt(previous)) return;
			let stage: Stage = "state";
			let outcome: Outcome = "network";
			// Survives process termination so repeated pi-web restores cannot hammer the remote.
			saveState({ version: 1, lastSuccess: previous?.lastSuccess ?? 0, nextAttempt: this.now() + MINUTE,
				failures: previous?.failures ?? 0, outcome: "network", stage, durationMs: 0 });
			try {
				stage = "status";
				const dirty = await unsafeWorktreeChanges(pi, execOptions());
				if (dirty.length) outcome = "dirty";
				else {
					stage = "pull";
					const result = await git(pi, ["-c", "core.hooksPath=", "-c", "credential.interactive=false", "-c", "merge.autoStash=false", "-c", "rebase.autoStash=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "pull", "--ff-only", "--quiet", "--no-rebase"], execOptions());
					if (result.code === 0 && !result.killed && !signal.aborted) {
						recordSyncSuccess(this.now(), Math.max(0, this.now() - started));
						return;
					}
					outcome = timeout.aborted || result.killed ? "timeout" : classify(result.stderr || result.stdout);
				}
			} catch {
				outcome = timeout.aborted ? "timeout" : stage === "status" ? "unavailable" : "network";
			}
			if (ownerSignal.aborted) {
				saveState({ version: 1, lastSuccess: previous?.lastSuccess ?? 0, nextAttempt: this.now() + MINUTE,
					failures: previous?.failures ?? 0, outcome: "cancelled", stage, durationMs: Math.max(0, this.now() - started) });
				return;
			}
			const failures = Math.min((previous?.failures ?? 0) + 1, 100);
			const delay = ["dirty", "auth", "diverged", "unavailable"].includes(outcome) ? this.interval :
				[MINUTE, 5 * MINUTE, 15 * MINUTE, HOUR][Math.min(failures - 1, 3)];
			saveState({ version: 1, lastSuccess: previous?.lastSuccess ?? 0, nextAttempt: this.now() + delay,
				failures, outcome, stage, durationMs: Math.max(0, this.now() - started) });
		}, { waitMs: 500, signal }).catch((err: unknown) => {
			this.busyUntil = this.now() + MINUTE;
			if (ownerSignal.aborted) return;
			throw err;
		});
	}
}

const REGISTRY = Symbol.for("memark.background-sync.v1");
const globals = globalThis as unknown as Record<symbol, Map<string, SyncScheduler> | undefined>;
function registry(): Map<string, SyncScheduler> {
	return globals[REGISTRY] ??= new Map();
}

export function startBackgroundSync(pi: ExtensionAPI): () => Promise<void> {
	const coordinators = registry();
	let scheduler = coordinators.get(REPO);
	if (!scheduler) {
		scheduler = new SyncScheduler({ onIdle: () => { if (coordinators.get(REPO) === scheduler) coordinators.delete(REPO); } });
		coordinators.set(REPO, scheduler);
	}
	return scheduler.attach(pi);
}

export async function cancelBackgroundDownload(): Promise<void> {
	await registry().get(REPO)?.cancelDownload();
}

export function backgroundSyncStatus(): string {
	const state = readSyncState();
	const last = state?.lastSuccess ? new Date(state.lastSuccess).toISOString() : "尚无成功记录";
	const descriptions: Record<Outcome, string> = { success: "下载成功", dirty: "工作区有修改，已跳过", timeout: "下载超时",
		network: "网络下载未完成", cancelled: "后台下载已取消", auth: "鉴权失败，请人工处理", diverged: "无法快进，请人工处理", unavailable: "Git 状态不可用" };
	return `后台下载周期：${syncIntervalMs() / MINUTE} 分钟；上次成功：${last}。\n` +
		(state ? `最近结果：${descriptions[state.outcome]}；阶段：${state.stage}；耗时：${state.durationMs} ms。\n` +
			(state.nextAttempt ? `下次允许尝试：${new Date(state.nextAttempt).toISOString()}。\n` : "") : "") +
		"recall 只读本地快照，不等待网络；立即完整同步用 /memory sync。";
}
