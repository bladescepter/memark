/* 审查发现的边界回归。只使用 run.sh 创建的公开 fixture 与本地 bare remote。
 * 文件队列使用真实 Pi 实现；故障注入不修改生产脚本或私人记忆。
 */
process.env.MEMARK_REPO = process.env.TEST_REPO;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { createRequire } = require("node:module");
const { createToolPipeline } = require("./tool-pipeline.cjs");
const REPO = process.env.TEST_REPO;
const sdk = process.env.MEMARK_TEST_PI_ROOT || path.resolve(process.env.PI_NODE_MODULES, "..");
const sdkRequire = createRequire(path.join(sdk, "package.json"));
const { createJiti } = createRequire(path.resolve(process.env.PI_NODE_MODULES, "../package.json"))("jiti");
const jiti = createJiti(__filename, { alias: {
	"@earendil-works/pi-coding-agent": path.join(__dirname, "stub-pi-coding-agent.cjs"),
	"@earendil-works/pi-ai": path.join(__dirname, "stub-pi-ai.cjs"),
	"@earendil-works/pi-tui": sdkRequire.resolve("@earendil-works/pi-tui"),
} });
const extension = jiti(path.join(__dirname, "../index.ts"));
const repo = jiti(path.join(__dirname, "../repo.ts"));
const metadata = jiti(path.join(__dirname, "../metadata.ts"));
const baseline = jiti(path.join(__dirname, "../baseline.ts"));
const { withFileMutationQueue } = require("./stub-pi-coding-agent.cjs");
const run = (cmd, args, opts = {}) => new Promise(resolve => execFile(cmd, args, { timeout: opts.timeout ?? 60000, signal: opts.signal }, (err, stdout, stderr) => resolve({
	code: err ? err.code ?? 1 : 0, stdout: String(stdout || ""), stderr: String(stderr || ""), killed: Boolean(err?.killed),
})));
const git = args => run("git", ["-C", REPO, ...args]);
const script = name => run("python3", [path.join(REPO, "scripts", name), "--root", REPO]);
const clean = async () => assert.equal((await git(["status", "--porcelain"])).stdout.trim(), "");
const valid = async () => { const r = await script("validate.py"); assert.equal(r.code, 0, r.stderr); };
const txt = result => result.content[0].text;
const file = rel => path.join(REPO, rel);
const pendingFiles = () => fs.readdirSync(file("pending")).filter(n => n.endsWith(".md") && n !== "README.md");
const pendingId = () => { assert.equal(pendingFiles().length, 1); return pendingFiles()[0].slice(0, -3); };
const draft = title => ({ title, description: title + "的独立边界测试", body: title + "的虚构正文。", tags: ["测试"], zone: "personal", type: "Principle" });
const gate = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
async function bounded(promise, ms = 3000) {
	let timer;
	try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("test deadline exceeded")), ms); })]); }
	finally { clearTimeout(timer); }
}
let afterStatus, afterPush, approve = async () => "Yes";
const tools = {}, commands = {}, notes = [], previews = [];
const ctx = { hasUI: true, mode: "rpc", cwd: "/workspace/none", ui: {
	notify: message => notes.push(message), confirm: async () => true,
	editor: async (title, prefill) => { assert(title.startsWith("memark：完整变更预览")); previews.push(prefill); return prefill; },
	select: async () => approve(),
} };
const pi = { registerTool: d => tools[d.name] = d, registerCommand: (n, d) => commands[n] = d, on() {}, appendEntry() {}, exec: async (cmd, args, opts) => {
	const result = await run(cmd, args, opts);
	if (cmd === "git" && args.includes("status") && afterStatus) afterStatus();
	if (cmd === "git" && args.includes("push") && afterPush) afterPush();
	return result;
} };
extension.default(pi);
const executeTool = createToolPipeline(sdk);
const remember = args => executeTool(tools.memark_remember, args, ctx);
const command = args => commands.memory.handler(args, ctx);
const recall = async (query, selected = tools, all_projects = false) => txt(await selected.memark_recall.execute("recall", { query, max_files: 10, all_projects }, undefined, undefined, { cwd: "/workspace/none" }));
function freshRecall(exec = pi.exec) {
	const fresh = {};
	extension.default({ ...pi, exec, registerTool: d => fresh[d.name] = d, registerCommand() {} });
	return fresh;
}

(async () => {
	await clean(); await valid();
	// 同一文件上的真实 Pi edit/write 队列；旧实现会返回成功并吃掉 CONCURRENT_EDIT。
	const protectedRel = "principles/清理前先备份.md";
	const before = fs.readFileSync(file(protectedRel), "utf8");
	const entered = gate(), release = gate();
	const writer = withFileMutationQueue(file(protectedRel), async () => {
		entered.resolve(); await release.promise;
		fs.appendFileSync(file(protectedRel), "\nCONCURRENT_EDIT\n");
	});
	await entered.promise;
	let statuses = 0;
	afterStatus = () => { if (++statuses === 2) { afterStatus = undefined; release.resolve(); } };
	const head = (await git(["rev-parse", "HEAD"])).stdout;
	const raced = await remember({ ...draft("清理前先备份"), edit: protectedRel });
	await writer;
	assert(txt(raced).includes("变化"));
	assert(fs.readFileSync(file(protectedRel), "utf8").includes("CONCURRENT_EDIT"));
	assert.equal((await git(["rev-parse", "HEAD"])).stdout, head);
	fs.writeFileSync(file(protectedRel), before);
	console.log("✓ 真实文件队列竞争：停止旧计划，保留另一处修改");

	// 即使 Git 忽略了晚到文件，也须比较预览快照，不能覆盖同名文件。
	const collision = "principles/忽略文件碰撞.md";
	const exclude = file(".git/info/exclude");
	const savedExclude = fs.readFileSync(exclude);
	fs.appendFileSync(exclude, `\n${collision}\n`);
	statuses = 0;
	afterStatus = () => { if (++statuses === 2) { afterStatus = undefined; fs.writeFileSync(file(collision), "OTHER_WRITER\n"); } };
	const collided = await remember(draft("忽略文件碰撞"));
	assert(txt(collided).includes("待审核候选"));
	assert.equal(fs.readFileSync(file(collision), "utf8"), "OTHER_WRITER\n");
	fs.rmSync(file(collision)); fs.writeFileSync(exclude, savedExclude);
	await command(`reject ${pendingId()}`);
	console.log("✓ 快照比较保护 Git 忽略的晚到文件");

	await remember({ ...draft("候选并发版本"), as_pending: true });
	let id = pendingId(), candidate = file(`pending/${id}.md`);
	const oldPending = fs.readFileSync(candidate, "utf8");
	approve = async () => { fs.appendFileSync(candidate, "\nPENDING_NEW_VERSION\n"); return "Yes"; };
	await command(`approve ${id}`);
	assert(!fs.existsSync(file("principles/候选并发版本.md")));
	assert(fs.readFileSync(candidate, "utf8").includes("PENDING_NEW_VERSION"));
	assert(notes.at(-1).includes("候选在审核期间已变化"));
	fs.writeFileSync(candidate, oldPending); approve = async () => "Yes";
	await command(`approve ${id}`); assert(!fs.existsSync(candidate));
	await remember({ ...draft("候选审核期间拒绝"), as_pending: true }); id = pendingId();
	approve = async () => { await command(`reject ${id}`); return "Yes"; };
	await command(`approve ${id}`); approve = async () => "Yes";
	assert(!fs.existsSync(file("principles/候选审核期间拒绝.md")));
	assert.equal(pendingFiles().length, 0);
	// 本机外部编辑器不走 Pi 队列：提交后发生的新版本也不得被清理掉。
	await remember({ ...draft("候选提交后版本"), as_pending: true }); id = pendingId(); candidate = file(`pending/${id}.md`);
	afterPush = () => { afterPush = undefined; fs.appendFileSync(candidate, "\nAFTER_COMMIT_VERSION\n"); };
	await command(`approve ${id}`);
	assert(fs.readFileSync(candidate, "utf8").includes("AFTER_COMMIT_VERSION"));
	assert(!fs.readFileSync(file("principles/候选提交后版本.md"), "utf8").includes("AFTER_COMMIT_VERSION"));
	assert(notes.at(-1).includes("已有新版本")); await command(`reject ${id}`);
	console.log("✓ pending 审核中更新、拒绝和提交后新版本均不被误删");

	const hooks = path.join(path.dirname(REPO), "safety-failing-hooks"); fs.mkdirSync(hooks);
	fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	await git(["config", "core.hooksPath", hooks]);
	const failed = await remember({ ...draft("新项目失败恢复"), zone: "project", project: "failed-new-project", type: "Topic" });
	await git(["config", "core.hooksPath", ".githooks"]);
	assert(txt(failed).startsWith("✗")); assert(!fs.existsSync(file("projects/failed-new-project")));
	await clean(); await valid();
	fs.mkdirSync(file("audit/existing-empty"));
	const snapshots = repo.snapshotFiles(["audit/existing-empty/new/entry.md"]);
	fs.mkdirSync(file("audit/existing-empty/new")); fs.writeFileSync(file("audit/existing-empty/new/entry.md"), "fixture");
	repo.restoreSnapshots(snapshots);
	assert(fs.existsSync(file("audit/existing-empty")) && !fs.existsSync(file("audit/existing-empty/new")));
	fs.rmdirSync(file("audit/existing-empty"));
	const withOtherContent = repo.snapshotFiles(["audit/late-content/entry.md"]);
	fs.mkdirSync(file("audit/late-content"));
	fs.writeFileSync(file("audit/late-content/entry.md"), "transaction");
	fs.writeFileSync(file("audit/late-content/other.md"), "USER_CONTENT");
	repo.restoreSnapshots(withOtherContent);
	assert.equal(fs.readFileSync(file("audit/late-content/other.md"), "utf8"), "USER_CONTENT");
	fs.rmSync(file("audit/late-content/other.md")); fs.rmdirSync(file("audit/late-content"));
	console.log("✓ 新项目 commit 失败恢复目录，保留既有空目录和其他内容");

	const identity = "identity/测试身份.md";
	const originalIdentity = fs.readFileSync(file(identity), "utf8");
	await recall("测试身份");
	for (const [candidateText, expected, validProtocol] of [
		[originalIdentity.replace("reviewed: true", "reviewed: false"), false, false],
		[originalIdentity.replace("status: active", "status: superseded"), false, false],
		[originalIdentity.replace("status: active", "status: archived"), false, false],
		[originalIdentity.replace("reviewed: true", 'reviewed: "true"'), false, false],
		[originalIdentity.replace("privacy: internal", "privacy: [internal]"), false, false],
		...['"2020-01-01"', "'2020-01-01'", '"2099-01-01"', "null", "~"].map(expiry => [originalIdentity.replace("reviewed: true", `reviewed: true\nexpires: ${expiry}`), !expiry.includes("2020"), true]),
	]) {
		fs.writeFileSync(file(identity), candidateText);
		assert.equal((await recall("测试身份")).includes(`===== ${identity} =====`), expected);
		assert.equal(baseline.buildBaselineContext().includes("测试身份"), expected);
		if (validProtocol) await valid();
	}
	fs.writeFileSync(file(identity), originalIdentity);
	const today = new Date().toISOString().slice(0, 10);
	assert(metadata.currentMemory(metadata.parseMetadata(originalIdentity.replace("reviewed: true", `reviewed: true\nexpires: '${today}'`))));
	assert.equal(metadata.parseSimpleFrontmatter(originalIdentity + "\nexpires: 2020-01-01").expires, undefined);
	assert.equal(metadata.parseMetadata(originalIdentity.replace("reviewed: true", "reviewed: true\nreviewed: false")), null);
	console.log("✓ recall 和基线统一拒绝未审/失效状态，正确处理带引号日期、null、~、到期当天和正文伪字段");

	const indexFile = file("INDEX.md"), index = fs.readFileSync(indexFile, "utf8");
	fs.writeFileSync(file("pending/not-reviewed.md"), originalIdentity);
	fs.writeFileSync(indexFile, index + "\n- [Identity] 隔离标记 — 隔离标记 — pending/not-reviewed.md\n- [Topic] 隔离标记 — 隔离标记 — projects/other/topics/其他项目秘密.md\n");
	assert(!(await recall("隔离标记")).includes("===== "));
	assert(!(await recall("隔离标记")).includes("pending/not-reviewed"));
	assert((await recall("跨项目唯一正文", tools, true)).includes("其他项目秘密"));
	fs.writeFileSync(indexFile, index); fs.rmSync(file("pending/not-reviewed.md"));

	fs.writeFileSync(file(identity), originalIdentity.replace("reviewed: true", "reviewed: true\nexpires: null\nsupersedes: null"));
	await valid(); await git(["add", "--", identity]);
	assert.equal((await git(["commit", "-qm", "memory: nullable metadata fixture"])).code, 0); await git(["push", "-q"]);
	const nullEdit = await remember({ ...draft("测试身份"), type: "Identity", edit: identity });
	assert(txt(nullEdit).startsWith("✓"));
	const nullResult = fs.readFileSync(file(identity), "utf8");
	assert(nullResult.includes("expires: null") && nullResult.includes("supersedes: null")); await valid();
	console.log("✓ 不信任错区索引；合法 null 治理字段可原地编辑且保留原值");

	const holdEntered = gate(), holdRelease = gate();
	const held = repo.withRepoMutation(async () => { holdEntered.resolve(); await holdRelease.promise; });
	await holdEntered.promise;
	let pulled = 0, expiredTurnRan = false;
	const fresh = freshRecall((cmd, args, opts) => { if (args.includes("pull")) pulled++; return pi.exec(cmd, args, opts); });
	const started = Date.now();
	const quick = await bounded(recall("测试身份", fresh));
	assert(Date.now() - started < 2500 && !quick.includes("自动同步失败") && quick.includes("测试身份"));
	await assert.rejects(bounded(repo.withRepoMutation(async () => { expiredTurnRan = true; }, { waitMs: 30 })), /另一项记忆写入/);
	const cancelled = new AbortController();
	const cancelledTurn = repo.withRepoMutation(async () => { expiredTurnRan = true; }, { signal: cancelled.signal });
	cancelled.abort(); await assert.rejects(bounded(cancelledTurn), /取消/);
	holdRelease.resolve(); await held;
	await repo.withRepoMutation(async () => {});
	assert.equal(pulled, 0); assert.equal(expiredTurnRan, false);
	console.log("✓ recall 不等待后台/审核写入；排队超时/取消的任务不会迟到执行或越过写入者");

	let recallExecs = 0;
	const slow = freshRecall(() => { recallExecs++; throw new Error("recall must not start network or Git status"); });
	const fallback = await bounded(recall("测试身份", slow));
	assert(fallback.includes("测试身份") && !fallback.includes("自动同步失败"));
	assert.equal(recallExecs, 0);
	console.log("✓ recall 不再执行同步或等待五秒预算");

	await remember({ ...draft("坏链接候选"), body: "[不存在](missing.md)", as_pending: true }); id = pendingId();
	assert(txt(await remember(draft("无关候选隔离写入"))).startsWith("✓"));
	await command(`approve ${id}`);
	assert(!fs.existsSync(file("principles/坏链接候选.md")) && fs.existsSync(file(`pending/${id}.md`)));
	assert(notes.at(-1).includes("草案校验未通过")); await command(`reject ${id}`);
	await remember({ ...draft("正式目标相对链接"), body: "[参照](清理前先备份.md)", as_pending: true }); id = pendingId();
	await command(`approve ${id}`);
	assert(fs.existsSync(file("principles/正式目标相对链接.md"))); assert.equal(pendingFiles().length, 0);
	console.log("✓ pending 坏链接不阻断无关写入；批准仍按正式路径检查链接");

	const newProject = { ...draft("完整撤销新项目"), zone: "project", project: "revert-new-project", type: "Topic" };
	assert(txt(await remember(newProject)).startsWith("✓"));
	approve = async () => "No"; await command("revert");
	assert(fs.existsSync(file("projects/revert-new-project/README.md")));
	assert(previews.at(-1).includes("-type: Topic") && previews.at(-1).includes("删除 projects/revert-new-project/README.md"));
	approve = async () => "Yes"; await command("revert");
	assert(!fs.existsSync(file("projects/revert-new-project"))); await clean(); await valid();
	assert((await git(["log", "-1", "--format=%b"])).stdout.includes("This reverts commit "));
	// 连续撤销会跳过上一个已撤销事务，而不是再次恢复它。
	await command("revert");
	assert(!fs.existsSync(file("principles/正式目标相对链接.md")));
	assert(!fs.existsSync(file("projects/revert-new-project"))); await valid();
	const supersede = { ...draft("撤销替代状态"), supersedes: identity };
	assert(txt(await remember(supersede)).startsWith("✓"));
	await command("revert");
	assert.equal(metadata.parseMetadata(fs.readFileSync(file(identity), "utf8")).status, "active");
	assert(!fs.existsSync(file("principles/撤销替代状态.md")));
	await clean(); await valid();
	console.log("✓ 撤销走完整 diff/预检；取消、新项目空目录、连续撤销和 supersedes 恢复正确");
	console.log("全部新增安全边界回归测试通过");
})().catch(error => { console.error(error); process.exitCode = 1; });
