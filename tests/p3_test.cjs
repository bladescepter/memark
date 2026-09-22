/* memark P3 curator 全流程回归测试。
 * 用法：sh tests/run.sh（自动搭建隔离 git 环境，不触碰真实 memory 仓库）
 * 依赖：全局安装的 pi（npm root -g 下 @earendil-works/pi-coding-agent/node_modules 提供 jiti/typebox）
 */
process.env.MEMARK_REPO = process.env.TEST_REPO || "/tmp/memark-test-repo";
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const G =
	process.env.PI_NODE_MODULES ||
	path.join(execSync("npm root -g").toString().trim(), "@earendil-works/pi-coding-agent/node_modules");
const { createJiti } = require(path.join(G, "jiti"));
const jiti = createJiti(__filename, {
	alias: { "@earendil-works/pi-ai": path.join(__dirname, "stub-pi-ai.cjs") },
});
const mod = jiti(path.join(__dirname, "..", "index.ts"));

const { execFile } = require("node:child_process");
const REPO = process.env.MEMARK_REPO;
const BARE = process.env.TEST_REMOTE || "/tmp/memark-test-remote.git";
const exec = (cmd, args) =>
	new Promise((res) =>
		execFile(cmd, args, { timeout: 60000 }, (err, stdout, stderr) =>
			res({ stdout: String(stdout || ""), stderr: String(stderr || ""), code: err ? err.code ?? 1 : 0, killed: false }),
		),
	);

const tools = {};
const commands = {};
const handlers = {};
const pi = {
	registerTool: (d) => (tools[d.name] = d),
	registerCommand: (n, o) => (commands[n] = o),
	on: (ev, fn) => (handlers[ev] = fn),
	exec,
};
mod.default(pi);

let confirmed = 0;
const ctx = {
	hasUI: true,
	ui: {
		confirm: async (t) => {
			confirmed++;
			console.log(`  [confirm#${confirmed}] ${t}`);
			return true;
		},
		notify: (m) => console.log(`  [notify] ${String(m).split("\n")[0]}`),
	},
	cwd: "/tmp",
};

const git = (args) => exec("git", ["-C", REPO, ...args]);
const assert = (cond, msg) => {
	if (!cond) {
		console.error(`✗ FAIL: ${msg}`);
		process.exit(1);
	}
	console.log(`✓ ${msg}`);
};

(async () => {
	// 回归：recall 排序
	const idx = fs.readFileSync(path.join(REPO, "INDEX.md"), "utf8").split("\n");
	assert(mod.matchIndexLines(idx, "备份")[0] === "principles/清理前先备份.md", "recall 排序回归通过");

	// ---- 1. Handoff 缺 expires 应直接报错 ----
	try {
		await tools.memark_remember.execute(
			"t0",
			{ title: "交接测试", description: "d", body: "b", tags: ["t"], zone: "project", project: "wiki", category: "handoffs", type: "Handoff" },
			undefined, undefined, ctx,
		);
		assert(false, "Handoff 缺 expires 应抛错");
	} catch (e) {
		assert(String(e.message).includes("expires"), "Handoff 缺 expires 被拒绝");
	}

	// ---- 2. pending 写入 → review → reject ----
	let r = await tools.memark_remember.execute(
		"t1",
		{ title: "P3 测试记忆", description: "curator 流程测试条目", body: "测试正文。", tags: ["测试"], zone: "personal", layer: "principles", type: "Principle", as_pending: true },
		undefined, undefined, ctx,
	);
	console.log(`  [tool] ${r.content[0].text}`);
	assert(fs.readdirSync(path.join(REPO, "pending")).some((f) => f.startsWith("20")), "pending 文件已创建");
	await commands.memory.handler("review", ctx);
	const pendingId = fs
		.readdirSync(path.join(REPO, "pending"))
		.find((f) => f.endsWith(".md") && f !== "README.md")
		.replace(/\.md$/, "");
	await commands.memory.handler(`reject ${pendingId}`, ctx);
	assert(!fs.readdirSync(path.join(REPO, "pending")).some((f) => f !== "README.md"), "reject 后 pending 清空");
	assert((await git(["status", "--porcelain"])).stdout.trim() === "", "reject 未产生 git 改动");

	// ---- 3a. 同名文件守卫 ----
	try {
		await tools.memark_remember.execute(
			"t2a",
			{ title: "能不动就不动", description: "重复文件名测试", body: "x", tags: ["测试"], zone: "personal", layer: "principles", type: "Principle" },
			undefined, undefined, ctx,
		);
		assert(false, "同名文件应被守卫拦截");
	} catch (e) {
		assert(String(e.message).includes("已存在"), "同名文件守卫生效");
	}

	// ---- 3b. 重复描述：仓库校验拦截并自清理 ----
	r = await tools.memark_remember.execute(
		"t2b",
		{ title: "最小化改动原则", description: "不引入额外复杂度，最小化系统改动", body: "与既有条目重复，应被拦截。", tags: ["测试"], zone: "personal", layer: "principles", type: "Principle" },
		undefined, undefined, ctx,
	);
	assert(r.content[0].text.startsWith("✗"), "重复描述被校验拦截");
	assert((await git(["status", "--porcelain"])).stdout.trim() === "", "拦截后工作区恢复干净");

	// ---- 4. 正式写入（confirm 自动同意） ----
	const before = (await git(["rev-parse", "HEAD"])).stdout.trim();
	r = await tools.memark_remember.execute(
		"t3",
		{ title: "P3 正式写入测试", description: "完整 curator 流程测试", body: "走完 pull→校验→确认→commit→push。", tags: ["测试"], zone: "project", project: "wiki", category: "topics", type: "Topic" },
		undefined, undefined, ctx,
	);
	console.log(`  [tool] ${r.content[0].text}`);
	assert(r.content[0].text.startsWith("✓"), "正式写入成功");
	assert(fs.existsSync(path.join(REPO, "projects/wiki/topics/P3正式写入测试.md")), "目标文件存在");
	const idxNow = fs.readFileSync(path.join(REPO, "INDEX.md"), "utf8");
	const projIdx = fs.readFileSync(path.join(REPO, "projects/wiki/INDEX.md"), "utf8");
	assert(projIdx.includes("P3 正式写入测试"), "项目 INDEX 已更新");
	assert(!idxNow.includes("P3 正式写入测试"), "根 INDEX 不含项目区条目");
	const subject = (await git(["log", "-1", "--pretty=%s"])).stdout.trim();
	assert(subject === "memory: projects/wiki/topics/P3正式写入测试.md", "commit message 正确");
	assert((await git(["status", "--porcelain"])).stdout.trim() === "", "提交后工作区干净");

	// ---- 5. forget 归档 ----
	await commands.memory.handler("forget projects/wiki/topics/P3正式写入测试.md", ctx);
	assert(!fs.existsSync(path.join(REPO, "projects/wiki/topics/P3正式写入测试.md")), "原位置文件已移除");
	assert(fs.existsSync(path.join(REPO, "archive/P3正式写入测试.md")), "已移入 archive/");
	assert((await git(["log", "-1", "--pretty=%s"])).stdout.trim() === "memory: archive projects/wiki/topics/P3正式写入测试.md", "归档 commit 正确");

	// ---- 6. revert 两次回到基线（跳过已回滚提交） ----
	await commands.memory.handler("revert", ctx); // 撤销归档
	await commands.memory.handler("revert", ctx); // 撤销写入
	const after = (await git(["rev-parse", "HEAD"])).stdout.trim();
	const diff = await git(["diff", before, after]);
	assert(diff.stdout.trim() === "", "两次 revert 后内容与基线一致");
	assert((await git(["status", "--porcelain"])).stdout.trim() === "", "最终工作区干净");

	// ---- 7. push 验证（bare 仓库同步） ----
	const bareHead = (await exec("git", ["-C", BARE, "rev-parse", "main"])).stdout.trim();
	assert(bareHead === after, "已推送到远端（bare）");

	// ---- 8. /memory status ----
	await commands.memory.handler("status", ctx);

	// ---- 9. sync：模拟绕过协议的手工编辑 → 自动重建索引 ----
	const f = path.join(REPO, "principles/清理前先备份.md");
	const orig = fs.readFileSync(f, "utf8");
	fs.writeFileSync(f, orig.replace("删除数据前必须备份；批量操作先 dry-run 确认后执行", "删除前必须备份；批量/破坏性操作先 dry-run"));
	await git(["add", "-A"]);
	await git(["commit", "-m", "manual edit simulation"]);
	await commands.memory.handler("sync", ctx);
	assert(fs.readFileSync(path.join(REPO, "INDEX.md"), "utf8").includes("批量/破坏性操作先 dry-run"), "sync 重建了过期索引");
	assert((await git(["status", "--porcelain"])).stdout.trim() === "", "sync 后工作区干净");
	const bareHead2 = (await exec("git", ["-C", BARE, "rev-parse", "main"])).stdout.trim();
	assert(bareHead2 === (await git(["rev-parse", "HEAD"])).stdout.trim(), "sync 已推送重建 commit");
	// 还原模拟编辑（非记忆 commit，/memory revert 应拒绝跨它们回滚，用原生 git revert 还原）
	const notes = [];
	ctx.ui.notify = (m) => { notes.push(String(m)); console.log(`  [notify] ${String(m).split("\n")[0]}`); };
	await commands.memory.handler("revert", ctx);
	assert(notes[notes.length - 1].includes("拒绝回滚"), "revert 正确拒绝跨非记忆提交");
	const choreHash = (await git(["rev-parse", "HEAD"])).stdout.trim();
	const manualHash = (await git(["rev-parse", "HEAD~1"])).stdout.trim();
	await git(["revert", "--no-edit", manualHash]); // manual edit simulation
	await git(["revert", "--no-edit", choreHash]); // chore: rebuild index
	await git(["push"]);
	const diff2 = await git(["diff", before, "HEAD"]);
	assert(diff2.stdout.trim() === "", "全部回滚后与基线一致");

	// ---- 10. session_start 自动同步（静默 pull，不 push） ----
	assert(typeof handlers.session_start === "function", "session_start handler 已注册");
	await handlers.session_start(); // 不应抛错（离线/分叉均静默）
	assert((await git(["status", "--porcelain"])).stdout.trim() === "", "session_start 同步后工作区干净");

	console.log("\n全部 P3 测试通过");
})().catch((e) => {
	console.error("HARNESS ERROR:", e);
	process.exit(1);
});
