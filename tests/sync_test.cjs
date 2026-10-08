/* Background sync regression: only run.sh's public fixture and local bare remote. */
process.env.MEMARK_REPO = process.env.TEST_REPO;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const G = process.env.PI_NODE_MODULES;
const sdk = process.env.MEMARK_TEST_PI_ROOT || path.resolve(G, "..");
const sdkRequire = createRequire(path.join(sdk, "package.json"));
const { createJiti } = createRequire(path.resolve(G, "../package.json"))("jiti");
const jiti = createJiti(__filename, { alias: {
	"@earendil-works/pi-coding-agent": path.join(__dirname, "stub-pi-coding-agent.cjs"),
	"@earendil-works/pi-ai": path.join(__dirname, "stub-pi-ai.cjs"),
	"@earendil-works/pi-tui": sdkRequire.resolve("@earendil-works/pi-tui"),
} });
const sync = jiti(path.join(__dirname, "../sync.ts"));
const repo = jiti(path.join(__dirname, "../repo.ts"));
const snapshot = jiti(path.join(__dirname, "../snapshot.ts"));
const extension = jiti(path.join(__dirname, "../index.ts"));
const REPO = process.env.TEST_REPO;
const STATE = path.join(REPO, ".git/memark-sync-state.json");
const HOUR = 3600000, MINUTE = 60000;
const run = (cmd, args, opts = {}) => new Promise(resolve => execFile(cmd, args, {
	timeout: opts.timeout ?? 60000, signal: opts.signal,
}, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout: String(stdout || ""), stderr: String(stderr || ""), killed: Boolean(err?.killed) })));
const git = args => run("git", ["-C", REPO, ...args]);
const reset = () => fs.rmSync(STATE, { force: true });
const gate = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
async function bounded(promise, ms = 4000) {
	let timer;
	try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("test deadline")), ms); })]); }
	finally { clearTimeout(timer); }
}
function harness(exec = run, options = {}) {
	let now = Date.now(), pulls = 0;
	const timers = new Map();
	const calls = [];
	const pi = { exec: async (cmd, args, opts) => {
		calls.push({ cmd, args, opts });
		if (args.includes("pull")) pulls++;
		return exec(cmd, args, opts);
	} };
	const scheduler = new sync.SyncScheduler({
		now: () => now,
		setTimer: (fn, delay) => { const token = { unref() {} }; timers.set(token, { fn: () => { timers.delete(token); fn(); }, delay }); return token; },
		clearTimer: token => timers.delete(token),
		...options,
	});
	return { scheduler, pi, calls, timers, attach: () => scheduler.attach(pi), advance: ms => { now += ms; }, pulls: () => pulls };
}

async function worker() {
	const pi = { exec: async (cmd, args, opts) => {
		if (args.includes("pull")) {
			fs.appendFileSync(process.env.SYNC_PULL_LOG, "pull\n");
			await new Promise(resolve => setTimeout(resolve, 150));
		}
		return run(cmd, args, opts);
	} };
	const scheduler = new sync.SyncScheduler();
	const stop = scheduler.attach(pi);
	await scheduler.check();
	await stop();
	const deadline = Date.now() + 4000;
	while (!sync.readSyncState()?.lastSuccess && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
	assert(sync.readSyncState()?.lastSuccess);
}

async function main() {
	assert.equal((await git(["status", "--porcelain"])).stdout.trim(), "");
	delete process.env.MEMARK_SYNC_INTERVAL_MS;
	assert.equal(sync.syncIntervalMs(), HOUR);
	for (const value of ["", "nope", "-1", "0", "99999999999"]) {
		process.env.MEMARK_SYNC_INTERVAL_MS = value; assert.equal(sync.syncIntervalMs(), HOUR);
	}
	process.env.MEMARK_SYNC_INTERVAL_MS = "7200000"; assert.equal(sync.syncIntervalMs(), 2 * HOUR);
	delete process.env.MEMARK_SYNC_INTERVAL_MS;

	reset();
	for (const payload of ["null", "{broken", JSON.stringify({ version: 1, lastSuccess: Number.MAX_SAFE_INTEGER, nextAttempt: 0, failures: 0, outcome: "success", stage: "pull", durationMs: 0 })]) {
		fs.writeFileSync(STATE, payload);
		assert.equal(sync.readSyncState(), null);
	}
	reset();
	const h = harness();
	const stop1 = h.attach(), stop2 = h.attach();
	assert.equal(h.calls.length, 0, "attach starts detached work, not inline network");
	assert.equal(h.timers.size, 1, "one timer for multiple owners");
	const first = h.scheduler.check();
	assert.strictEqual(first, h.scheduler.check(), "parallel checks share one task");
	await first;
	assert.equal(h.pulls(), 1);
	assert(sync.readSyncState().lastSuccess);
	assert.equal(sync.readSyncState().outcome, "success");
	assert(h.calls.every(c => c.cmd === "git" && !c.args.includes("push") && !c.args.includes("commit")));
	const pull = h.calls.find(c => c.args.includes("pull"));
	assert(pull.opts.timeout > 5000 && pull.opts.timeout <= 60000);
	assert.equal(fs.statSync(STATE).mode & 0o777, 0o600);
	h.advance(59 * MINUTE); await h.scheduler.check(); assert.equal(h.pulls(), 1);
	assert.equal([...h.timers.values()][0].delay, MINUTE);
	h.advance(MINUTE); [...h.timers.values()][0].fn(); await h.scheduler.check(); assert.equal(h.pulls(), 2);
	await stop1(); assert.equal(h.timers.size, 1);
	await stop2(); assert.equal(h.timers.size, 0);
	console.log("✓ 一小时新鲜度、共享任务/定时器、60 秒后台预算与退出清理");

	// Recreate the extension through the installed Pi loader, as /resume and reload do.
	reset();
	await repo.withRepoMutation(async () => sync.recordSyncSuccess());
	const { loadExtensionFromFactory, createExtensionRuntime } = await import(pathToFileURL(path.join(sdk, "dist/core/extensions/loader.js")).href);
	const { createEventBus } = await import(pathToFileURL(path.join(sdk, "dist/core/event-bus.js")).href);
	for (const reason of ["startup", "resume", "reload"]) {
		const loaded = await loadExtensionFromFactory(extension.default, REPO, createEventBus(), createExtensionRuntime());		for (const handler of loaded.handlers.get("session_start")) await handler({ type: "session_start", reason }, {});
		await new Promise(resolve => setTimeout(resolve, 15));
		for (const handler of loaded.handlers.get("session_shutdown")) await handler({ type: "session_shutdown", reason: "quit" }, {});
		assert(sync.readSyncState().lastSuccess);
	}
	const restored = harness(); const endRestored = restored.attach();
	await restored.scheduler.check(); assert.equal(restored.pulls(), 0);
	restored.advance(HOUR); await restored.scheduler.check(); assert.equal(restored.pulls(), 1);
	await endRestored();
	console.log("✓ 真实 Pi 工厂重新初始化、resume/reload 生命周期与闲置回收后共享新鲜度");

	reset();
	let offline = true;
	const retry = harness((cmd, args, opts) => args.includes("pull") && offline
		? Promise.resolve({ code: 1, stderr: "https://SECRET_TOKEN@example.invalid unreachable", stdout: "", killed: false })
		: run(cmd, args, opts));
	const endRetry = retry.attach();
	await retry.scheduler.check(); assert.equal(sync.readSyncState().outcome, "network");
	assert(!fs.readFileSync(STATE, "utf8").includes("SECRET_TOKEN"));
	retry.advance(MINUTE - 1); await retry.scheduler.check(); assert.equal(retry.pulls(), 1);
	retry.advance(1); await retry.scheduler.check(); assert.equal(retry.pulls(), 2);
	retry.advance(5 * MINUTE); offline = false; await retry.scheduler.check();
	assert.equal(retry.pulls(), 3); assert.equal(sync.readSyncState().failures, 0);
	assert.equal(sync.readSyncState().outcome, "success");
	await endRetry();
	console.log("✓ 离线退避、恢复重试与本机状态脱敏");

	reset();
	const protectedFile = path.join(REPO, "principles/清理前先备份.md");
	const original = fs.readFileSync(protectedFile, "utf8");
	fs.appendFileSync(protectedFile, "\nUSER_CHANGE\n");
	const dirty = harness(); const endDirty = dirty.attach();
	try {
		await dirty.scheduler.check(); assert.equal(dirty.pulls(), 0);
		assert.equal(sync.readSyncState().outcome, "dirty");
		assert(fs.readFileSync(protectedFile, "utf8").includes("USER_CHANGE"));
	} finally { fs.writeFileSync(protectedFile, original); await endDirty(); }
	for (const [stderr, outcome] of [["Permission denied (publickey)", "auth"], ["Not possible to fast-forward", "diverged"]]) {
		reset(); const fatal = harness((cmd, args, opts) => args.includes("pull")
			? Promise.resolve({ code: 1, stderr, stdout: "", killed: false }) : run(cmd, args, opts));
		const end = fatal.attach(); await fatal.scheduler.check();
		assert.equal(sync.readSyncState().outcome, outcome);
		fatal.advance(MINUTE); await fatal.scheduler.check(); assert.equal(fatal.pulls(), 1);
		await end();
	}
	console.log("✓ 未提交修改保护、鉴权/非快进分类、不密集重试");

	reset();
	const timed = harness((cmd, args, opts) => args.includes("pull") ? new Promise(resolve => {
		opts.signal.addEventListener("abort", () => resolve({ code: 1, stdout: "", stderr: "", killed: true }), { once: true });
	}) : run(cmd, args, opts), { timeoutMs: 80 });
	const endTimed = timed.attach(); await bounded(timed.scheduler.check());
	assert.equal(sync.readSyncState().outcome, "timeout"); await endTimed();

	reset();
	const entered = gate();
	const cancelling = harness((cmd, args, opts) => args.includes("status") ? new Promise(resolve => {
		entered.resolve();
		opts.signal.addEventListener("abort", () => resolve({ code: 1, stdout: "", stderr: "cancelled", killed: true }), { once: true });
	}) : run(cmd, args, opts));
	const endCancelling = cancelling.attach(); const task = cancelling.scheduler.check();
	await bounded(entered.promise); await bounded(endCancelling()); await task;
	assert.equal(cancelling.pulls(), 0); assert.equal(cancelling.timers.size, 0);
	assert.equal(sync.readSyncState().outcome, "cancelled");
	await bounded(repo.withRepoMutation(async () => {}));
	console.log("✓ 超时/退出取消传播到 exec，释放锁且不迟到拉取");

	reset();
	const manualEntered = gate();
	let cancelledPulls = 0;
	const stopGlobal = sync.startBackgroundSync({ exec: async (cmd, args, opts) => {
		if (args.includes("pull")) cancelledPulls++;
		if (args.includes("status")) return new Promise(resolve => {
			manualEntered.resolve();
			opts.signal.addEventListener("abort", () => resolve({ code: 1, stdout: "", stderr: "cancelled", killed: true }), { once: true });
		});
		return run(cmd, args, opts);
	} });
	await bounded(manualEntered.promise);
	let memoryCommand;
	extension.default({ on() {}, registerTool() {}, registerCommand: (_name, d) => memoryCommand = d, exec: run });
	const manualNotes = [];
	await bounded(memoryCommand.handler("sync", { cwd: REPO, hasUI: false, mode: "rpc", ui: { notify: text => manualNotes.push(text) } }), 10000);
	assert(manualNotes.some(text => text.startsWith("已同步到")), manualNotes.join("\n"));
	assert.equal(cancelledPulls, 0);
	assert.equal(sync.readSyncState().outcome, "success");
	assert.equal(sync.readSyncState().nextAttempt, 0);
	await stopGlobal();
	console.log("✓ 手动 sync 取消同进程后台下载并清除旧失败/退避状态");

	reset();
	const holdEntered = gate(), holdRelease = gate();
	const held = repo.withRepoMutation(async () => { holdEntered.resolve(); await holdRelease.promise; });
	await holdEntered.promise;
	const busy = harness(); const endBusy = busy.attach();
	await bounded(busy.scheduler.check()); assert.equal(busy.pulls(), 0); assert.equal(sync.readSyncState(), null);
	holdRelease.resolve(); await held; await endBusy();
	console.log("✓ 仓库忙短暂等待后跳过，不污染其他会话的成功记录");

	// Simulate the intermediate checkout of a writer; reads must use the old immutable commit.
	await repo.withRepoMutation(async () => {
		const index = path.join(REPO, "INDEX.md"), savedIndex = fs.readFileSync(index, "utf8");
		try {
			fs.writeFileSync(index, "INCOMPLETE_INDEX\n");
			fs.writeFileSync(protectedFile, "INCOMPLETE_BODY\n");
			const view = snapshot.captureMemorySnapshot();
			assert.deepEqual(view.read("principles/清理前先备份.md"), original);
			assert(!view.index().join("\n").includes("INCOMPLETE_INDEX"));
			const personal = snapshot.captureMemorySnapshot({ layers: ["identity", "principles", "preferences"], projects: [] });
			assert.deepEqual(personal.projects(), []);
			assert.equal(personal.read("projects/wiki/topics/单写者纪律.md"), null);
			const tools = {};
			extension.default({ on() {}, registerCommand() {}, registerTool: d => tools[d.name] = d, exec() { throw Error("no foreground network"); } });
			const result = await tools.memark_recall.execute("r", { query: "备份" }, undefined, undefined, { cwd: REPO });
			assert(result.content[0].text.includes("清理前先备份"));
			assert(!result.content[0].text.includes("INCOMPLETE_BODY"));
		} finally { fs.writeFileSync(index, savedIndex); fs.writeFileSync(protectedFile, original); }
	});
	console.log("✓ 写入/后台更新期间 recall 读取同一个已提交快照，不等待网络或仓库锁");

	// Real pull: honor ff-only even if local pull.rebase is enabled, and never run merge hooks.
	const remote = path.join(path.dirname(REPO), "background-writer");
	assert.equal((await run("git", ["clone", "-q", process.env.TEST_REMOTE, remote])).code, 0);
	for (const [key, value] of [["user.name", "fixture"], ["user.email", "fixture@memark.local"]]) await run("git", ["-C", remote, "config", key, value]);
	const remoteFile = "preferences/BackgroundFixture.md";
	fs.writeFileSync(path.join(remote, remoteFile), "---\ntype: Preference\ntitle: BackgroundFixture\ndescription: background sync fixture\nstatus: active\nprivacy: internal\ntags: [test]\ntimestamp: 2026-09-22\nsource: user-confirmed\nreviewed: true\n---\n\nREMOTE_ONLY\n");
	assert.equal((await run("python3", [path.join(remote, "scripts/generate_index.py"), "--root", remote])).code, 0);
	await run("git", ["-C", remote, "add", "--", remoteFile, "INDEX.md"]);
	assert.equal((await run("git", ["-C", remote, "commit", "-qm", "memory: background fixture"])).code, 0);
	assert.equal((await run("git", ["-C", remote, "push", "-q"])).code, 0);
	const hooks = (await git(["config", "--get", "core.hooksPath"])).stdout.trim();
	const rebase = (await git(["config", "--get", "pull.rebase"])).stdout.trim();
	const hookFile = path.join(REPO, ".git/hooks/post-merge");
	const hookMarker = path.join(REPO, ".git/unexpected-hook");
	fs.writeFileSync(hookFile, "#!/bin/sh\ntouch \"$(git rev-parse --git-dir)/unexpected-hook\"\n", { mode: 0o700 });
	await git(["config", "core.hooksPath", ".git/hooks"]); await git(["config", "pull.rebase", "true"]);
	reset();
	const actual = harness(); const endActual = actual.attach();
	try {
		await actual.scheduler.check();
		assert.equal(sync.readSyncState().outcome, "success");
		assert(fs.readFileSync(path.join(REPO, remoteFile), "utf8").includes("REMOTE_ONLY"));
		assert(!fs.existsSync(hookMarker));
		assert.equal((await git(["rev-parse", "HEAD"])).stdout, (await run("git", ["-C", remote, "rev-parse", "HEAD"])).stdout);
	} finally {
		await endActual(); fs.rmSync(hookFile, { force: true });
		await git(hooks ? ["config", "core.hooksPath", hooks] : ["config", "--unset", "core.hooksPath"]);
		await git(rebase ? ["config", "pull.rebase", rebase] : ["config", "--unset", "pull.rebase"]);
	}
	console.log("✓ 真实远端快进下载，覆盖 rebase 配置、不执行 hook、不生成本地提交");

	reset();
	const log = path.join(path.dirname(REPO), "cross-process-pulls.log");
	process.env.SYNC_PULL_LOG = log;
	const children = await Promise.all([1, 2].map(() => run(process.execPath, [__filename, "--worker"])));
	for (const child of children) assert.equal(child.code, 0, child.stderr);
	assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 1);
	console.log("✓ 两个真实 Node 进程共享仓库锁与成功时间，只执行一次 pull");

	assert.equal((await git(["status", "--porcelain"])).stdout.trim(), "");
	assert.equal((await git(["rev-parse", "HEAD"])).stdout, (await git(["rev-parse", "@{upstream}"])).stdout);
	console.log("全部后台同步回归测试通过");
}
(process.argv.includes("--worker") ? worker() : main()).catch(err => { console.error(err); process.exitCode = 1; });
