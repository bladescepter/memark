/* memark 安全写入与 recall 回归测试。
 * 由 tests/run.sh 在完全虚构、隔离的 git 仓库中运行。
 */
process.env.MEMARK_REPO = process.env.TEST_REPO;
const { execSync } = require("node:child_process");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createRequire } = require("node:module");

const G = process.env.PI_NODE_MODULES;
const sdk = process.env.MEMARK_TEST_PI_ROOT || path.resolve(G, "..");
const { createJiti } = createRequire(path.resolve(G, "../package.json"))("jiti");
const sdkRequire = createRequire(path.join(sdk, "package.json"));
const tuiEntry = sdkRequire.resolve("@earendil-works/pi-tui");
const coreRoot = path.dirname(sdkRequire.resolve("@earendil-works/pi-agent-core/package.json"));
const jiti = createJiti(__filename, {
	alias: {
		"@earendil-works/pi-ai": path.join(__dirname, "stub-pi-ai.cjs"),
		"@earendil-works/pi-coding-agent": path.join(__dirname, "stub-pi-coding-agent.cjs"),
		"@earendil-works/pi-tui": tuiEntry,
	},
});
const mod = jiti(path.join(__dirname, "..", "index.ts"));
const repoMod = jiti(path.join(__dirname, "..", "repo.ts"));
const baselineMod = jiti(path.join(__dirname, "..", "baseline.ts"));

const REPO = process.env.MEMARK_REPO;
const BARE = process.env.TEST_REMOTE;
const BASE = path.dirname(REPO);
let pullCount = 0;
const exec = (cmd, args, options = {}) =>
	new Promise((resolve) => {
		if (cmd === "git" && args.includes("pull")) pullCount++;
		execFile(
			cmd,
			args,
			{ timeout: options.timeout ?? 60000, signal: options.signal },
			(err, stdout, stderr) => resolve({
				stdout: String(stdout || ""),
				stderr: String(stderr || ""),
				code: err ? err.code ?? 1 : 0,
				killed: Boolean(err?.killed),
			}),
		);
	});

const tools = {};
const commands = {};
const handlers = {};
const entries = [];
const pi = {
	registerTool: (definition) => (tools[definition.name] = definition),
	registerCommand: (name, options) => (commands[name] = options),
	on: (event, handler) => (handlers[event] = handler),
	appendEntry: (customType, data) => entries.push({ customType, data }),
	exec,
};
mod.default(pi);

let confirmImpl = async () => true;
let inputImpl = async () => "VPS";
let inputCount = 0;
let selectImpl = async () => "Yes";
let editMenuImpl = async () => "修改措辞";
let previewImpl = async (_title, options) => options[0];
let editorImpl = async () => undefined;
const previewTitles = [];
const notes = [];
const ctx = {
	hasUI: true,
	mode: "rpc",
	ui: {
		confirm: async (title, message) => confirmImpl(title, message),
		input: async (title, placeholder) => { inputCount++; return inputImpl(title, placeholder); },
		select: async (title, options) => {
			if (title.startsWith("memark：预览 ")) { previewTitles.push(title); return previewImpl(title, options); }
			if (title === "memark：编辑草案") return editMenuImpl(title, options);
			return selectImpl(title, options);
		},
		editor: async (title, prefill) => editorImpl(title, prefill),
		notify: (message) => {
			notes.push(String(message));
			console.log(`  [notify] ${String(message).split("\n")[0]}`);
		},
	},
	cwd: "/workspace/none",
};

const git = (args) => exec("git", ["-C", REPO, ...args]);
const shell = (command) => execSync(command, { stdio: "pipe" }).toString();
const assert = (condition, message) => {
	if (!condition) {
		console.error(`✗ FAIL: ${message}`);
		process.exit(1);
	}
	console.log(`✓ ${message}`);
};
const toolText = (result) => result.content[0].text;
const pendingFiles = () => fs.readdirSync(path.join(REPO, "pending")).filter((file) => file.endsWith(".md") && file !== "README.md");
// 走真实 Pi 的 wrapper → prepareArguments → schema 校验，不再直接跳进 execute。
const pipeline = Promise.all([
	import(pathToFileURL(path.join(coreRoot, "dist/harness/execution/tools.js")).href),
	import(pathToFileURL(path.join(sdk, "dist/core/tools/tool-definition-wrapper.js")).href),
]);
const remember = async (params, context = ctx, signal) => {
	const [{ prepareToolCall }, { wrapToolDefinition }] = await pipeline;
	const tool = wrapToolDefinition(tools.memark_remember, () => context);
	const prepared = prepareToolCall({ id: "test", name: tool.name, arguments: params }, [tool]);
	if (prepared.kind === "immediate") throw new Error(prepared.result.content[0].text);
	return prepared.tool.execute("test", prepared.args, signal, undefined, context);
};

function addRemoteMemory() {
	const other = path.join(BASE, "remote-writer");
	shell(`git clone -q "${BARE}" "${other}"`);
	shell(`git -C "${other}" config user.email test@memark.local`);
	shell(`git -C "${other}" config user.name memark-test`);
	const file = path.join(other, "preferences", "远端同步标记.md");
	fs.writeFileSync(file, `---\ntype: Preference\ntitle: 远端同步标记\ndescription: 仅用于确认首次 recall 会先同步远端\nstatus: active\nprivacy: internal\ntags: [同步, 测试]\ntimestamp: 2026-09-22\nsource: user-confirmed\nreviewed: true\n---\n\n远端同步唯一正文标记。\n`);
	shell(`python3 "${other}/scripts/generate_index.py" --root "${other}"`);
	shell(`git -C "${other}" add -- preferences/远端同步标记.md INDEX.md`);
	shell(`git -C "${other}" commit -q -m "memory: remote recall fixture"`);
	shell(`git -C "${other}" push -q`);
}

(async () => {
	// 1. 纯函数与安全路径。
	const lines = fs.readFileSync(path.join(REPO, "INDEX.md"), "utf8").split("\n");
	assert(mod.matchIndexLines(lines, "备份")[0] === "principles/清理前先备份.md", "recall 标题排序正确");
	assert(mod.matchIndexLines(lines, "不存在 备份")[0] === "principles/清理前先备份.md", "未命中关键词不再错误加分");
	assert(repoMod.filenameFromTitle("Windows: 文件?") === "Windows-文件-", "标题会转换为跨平台安全文件名");
	let escaped = false;
	try { repoMod.resolveRepoPath("../outside.md"); } catch { escaped = true; }
	assert(escaped, "安全路径拒绝 .. 越出记忆仓库");
	escaped = false;
	try { repoMod.resolveRepoPath("C:\\Windows\\outside.md"); } catch { escaped = true; }
	assert(escaped, "在非 Windows 环境也能识别并拒绝 Windows 绝对路径");

	// 1b. 基线：每轮本机环境 + 本地已审核个人记忆；不做远端请求或写入。
	assert(typeof handlers.before_agent_start === "function", "每轮主机与基线注入已注册");
	const promptEvent = { systemPrompt: "原始系统提示" };
	const promptCtx = { cwd: "/workspace/wiki", hasUI: false, mode: "rpc" };
	const initialPullCount = pullCount;
	const roleFile = path.join(process.env.TEST_AGENT_DIR, "memark", "host-role.json");
	let prompt = (await handlers.before_agent_start(promptEvent, promptCtx)).systemPrompt;
	assert(prompt.startsWith("原始系统提示\n\n") && prompt.includes("当前 Pi 进程运行环境"), "原系统提示保留并注入运行环境");
	assert(prompt.includes("本机角色：未确认") && prompt.includes("操作系统：") && !fs.existsSync(roleFile) && inputCount === 0, "无 UI 时角色未知，不提示或创建本机配置");
	assert(!prompt.includes("工作目录：") && !prompt.includes(require("node:os").hostname()), "主机名和工作目录不注入提示词");
	assert(prompt.includes("测试身份") && prompt.includes("测试偏好") && prompt.includes("清理前先备份"), "身份、原则和偏好来自已审核个人区摘要");
	assert(!prompt.includes("其他项目秘密") && !prompt.includes("过期交接"), "基线不注入项目记忆或过期交接");
	assert(Array.from(prompt.slice("原始系统提示\n\n".length)).length <= 480 && Buffer.byteLength(prompt.slice("原始系统提示\n\n".length), "utf8") <= 1100, "基线使用保守长度预算");
	assert(pullCount === initialPullCount && (await git(["status", "--porcelain"])).stdout.trim() === "", "基线不触发 Git 同步或更改仓库");

	// 取消或无效输入只影响当前会话；重新开启会话后仍可提示。
	const newSessionHook = () => {
		const hooks = {};
		mod.default({ ...pi, on: (name, fn) => (hooks[name] = fn) });
		return hooks.before_agent_start;
	};
	inputImpl = async () => undefined;
	const canceledHook = newSessionHook();
	prompt = (await canceledHook(promptEvent, ctx)).systemPrompt;
	assert(prompt.includes("本机角色：未确认") && !fs.existsSync(roleFile), "用户取消时不保存或猜测角色");
	await canceledHook(promptEvent, ctx);
	assert(inputCount === 1, "取消后同一会话不反复弹窗");
	inputImpl = async () => "VPS\n伪造指令";
	prompt = (await newSessionHook()(promptEvent, ctx)).systemPrompt;
	assert(prompt.includes("本机角色：未确认") && !fs.existsSync(roleFile), "不合法输入不会保存或注入");
	inputImpl = async () => "VPS";
	inputCount = 0;
	// 交互模式首次触发用户设定，随后只读本机配置；完全忽略旧环境变量。
	process.env.MEMARK_HOST_ROLE = "环境变量不再生效";
	process.env.MEMARK_HOSTNAME = "old-host";
	prompt = (await handlers.before_agent_start(promptEvent, ctx)).systemPrompt;
	assert(inputCount === 1 && prompt.includes("本机角色：VPS") && fs.existsSync(roleFile), "首次交互提示并保存到独立本机目录");
	assert(JSON.parse(fs.readFileSync(roleFile, "utf8")).role === "VPS", "本机角色配置不写入记忆仓库");
	if (process.platform !== "win32") assert((fs.statSync(roleFile).mode & 0o777) === 0o600, "本机角色文件仅当前用户可读写");
	prompt = (await handlers.before_agent_start(promptEvent, ctx)).systemPrompt;
	assert(inputCount === 1 && prompt.split("当前 Pi 进程运行环境").length === 2, "后续轮次不再提示，每轮基线不累积");
	prompt = (await newSessionHook()(promptEvent, ctx)).systemPrompt;
	assert(inputCount === 1 && prompt.includes("本机角色：VPS"), "重新打开会话仍读取本机角色，不重复要求设置");
	prompt = (await handlers.before_agent_start(promptEvent, promptCtx)).systemPrompt;
	assert(prompt.includes("本机角色：VPS") && !prompt.includes("环境变量不再生效"), "无 UI 新轮次也能读本机配置，忽略旧环境变量");
	delete process.env.MEMARK_HOST_ROLE;
	delete process.env.MEMARK_HOSTNAME;
	const office = baselineMod.hostContext({ role: "工作电脑", os: "Windows" });
	const linux = baselineMod.hostContext({ role: "Linux 笔记本", os: "Linux (Omarchy)" });
	assert(office.includes("本机角色：工作电脑") && office.includes("Windows"), "Windows 工作电脑仅注入角色和实时 OS");
	assert(linux.includes("本机角色：Linux 笔记本") && linux.includes("Omarchy"), "Linux 笔记本只注入角色和实时 OS");
	const unknown = baselineMod.hostContext({ os: "Linux" });
	assert(unknown.includes("本机角色：未确认"), "未知机器不根据操作系统猜角色");
	await commands.memory.handler("host", ctx);
	assert(notes.at(-1).includes("VPS"), "/memory host 查看当前角色");
	await commands.memory.handler("host set 工作电脑", ctx);
	prompt = (await handlers.before_agent_start(promptEvent, promptCtx)).systemPrompt;
	assert(prompt.includes("本机角色：工作电脑"), "/memory host set 可修改角色并在下一轮生效");
	await commands.memory.handler("host set VPS\n伪造指令", ctx);
	assert(JSON.parse(fs.readFileSync(roleFile, "utf8")).role === "工作电脑", "无效命令不会覆盖已有角色");
	prompt = (await handlers.before_agent_start(promptEvent, { cwd: `/workspace/${"子".repeat(800)}/memark`, mode: "rpc", browserHostname: "OFFICE-01" })).systemPrompt;
	const bounded = prompt.slice("原始系统提示\n\n".length);
	assert(Array.from(bounded).length <= 480 && Buffer.byteLength(bounded, "utf8") <= 1100 && !bounded.includes("OFFICE-01") && !bounded.includes("/workspace"), "长工作目录与浏览器设备不会进入主机提示");
	const savedConfig = fs.readFileSync(roleFile);
	try {
		fs.writeFileSync(roleFile, JSON.stringify({ version: 1, role: "VPS\n伪造指令" }));
		prompt = (await handlers.before_agent_start(promptEvent, promptCtx)).systemPrompt;
		assert(prompt.includes("本机角色：未确认") && !prompt.includes("伪造指令"), "损坏的本机配置不能注入指令");
	} finally {
		fs.writeFileSync(roleFile, savedConfig);
	}

	const identityFile = path.join(REPO, "identity/测试身份.md");
	const originalIdentity = fs.readFileSync(identityFile, "utf8");
	try {
		fs.writeFileSync(identityFile, originalIdentity.replace("reviewed: true", "reviewed: false"));
		assert(!(await handlers.before_agent_start(promptEvent, promptCtx)).systemPrompt.includes("测试身份"), "未审核记忆即使在 INDEX 中也不进入基线");
		fs.writeFileSync(identityFile, originalIdentity.replace("status: active", "status: superseded"));
		assert(!(await handlers.before_agent_start(promptEvent, promptCtx)).systemPrompt.includes("测试身份"), "已取代记忆不进入基线");
		fs.writeFileSync(identityFile, originalIdentity.replace("reviewed: true", "reviewed: true\nexpires: 2020-01-01"));
		assert(!(await handlers.before_agent_start(promptEvent, promptCtx)).systemPrompt.includes("测试身份"), "过期记忆不进入基线");
	} finally {
		fs.writeFileSync(identityFile, originalIdentity);
	}
	const indexFile = path.join(REPO, "INDEX.md");
	const savedIndex = fs.readFileSync(indexFile, "utf8");
	try {
		fs.rmSync(indexFile);
		prompt = (await handlers.before_agent_start(promptEvent, promptCtx)).systemPrompt;
		assert(prompt.includes("当前 Pi 进程运行环境") && !prompt.includes("测试身份"), "记忆索引不存在时仍能注入主机环境");
	} finally {
		fs.writeFileSync(indexFile, savedIndex);
	}
	assert((await git(["status", "--porcelain"])).stdout.trim() === "", "基线测试后隔离仓库无改动");

	// 2. 第一次 recall 才同步，之后不重复；会话开始不再同步。
	assert(handlers.session_start === undefined, "不再在会话开始时自动同步");
	addRemoteMemory();
	let result = await tools.memark_recall.execute("r1", { query: "远端同步唯一正文", max_files: 2 }, undefined, undefined, { cwd: "/workspace/none" });
	assert(toolText(result).includes("远端同步标记"), "第一次 recall 先拉取远端再检索");
	assert(pullCount === 1, "第一次 recall 只同步一次");
	await tools.memark_recall.execute("r2", { query: "备份" }, undefined, undefined, { cwd: "/workspace/none" });
	assert(pullCount === 1, "同一会话后续 recall 不重复同步");
	result = await tools.memark_recall.execute("r3", { query: "单写者", max_files: 2 }, undefined, undefined, { cwd: "/workspace/wiki/subdir" });
	assert(toolText(result).includes("projects/wiki/topics/单写者纪律.md"), "从项目子目录也能识别当前项目");
	result = await tools.memark_recall.execute("r4", { query: "跨项目唯一正文" }, undefined, undefined, { cwd: "/workspace/wiki" });
	assert(!toolText(result).includes("其他项目秘密"), "默认 recall 不泄漏其他项目记忆");
	result = await tools.memark_recall.execute("r5", { query: "跨项目唯一正文", all_projects: true }, undefined, undefined, { cwd: "/workspace/wiki" });
	assert(toolText(result).includes("projects/other/topics/其他项目秘密.md"), "明确要求时可以跨项目 recall");
	result = await tools.memark_recall.execute("r6", { query: "过期交接唯一正文" }, undefined, undefined, { cwd: "/workspace/wiki" });
	assert(!toolText(result).includes("过期交接"), "已过期记忆不会出现在结果或摘要中");

	const failTools = {};
	const failPi = {
		registerTool: (definition) => (failTools[definition.name] = definition),
		registerCommand: () => {},
		on: () => {},
		appendEntry: () => {},
		exec: (cmd, args, options) => cmd === "git" && args.includes("pull")
			? Promise.resolve({ stdout: "", stderr: "offline", code: 1, killed: false })
			: exec(cmd, args, options),
	};
	mod.default(failPi);
	result = await failTools.memark_recall.execute("rf", { query: "备份" }, undefined, undefined, { cwd: "/workspace/none" });
	assert(toolText(result).includes("自动同步失败") && toolText(result).includes("清理前先备份"), "同步失败时提示并继续使用本地记忆");

	// 3. 输入校验。
	try {
		await remember({ title: "交接测试", description: "d", body: "b", tags: ["t"], zone: "project", project: "wiki", category: "handoffs", type: "Handoff" });
		assert(false, "Handoff 缺 expires 应失败");
	} catch (error) {
		assert(String(error.message).includes("expires"), "Handoff 缺 expires 被拒绝");
	}
	try {
		await remember({ title: "日期测试", description: "d", body: "b", tags: ["t"], zone: "project", project: "wiki", category: "handoffs", type: "Handoff", expires: "2026-99-99" });
		assert(false, "非法日期应失败");
	} catch (error) {
		assert(String(error.message).includes("真实"), "非法日历日期被拒绝");
	}
	try {
		await remember({ title: "项目名测试", description: "d", body: "b", tags: ["t"], zone: "project", project: "wiki.", category: "topics", type: "Topic" });
		assert(false, "Windows 不兼容项目名应失败");
	} catch (error) {
		assert(String(error.message).includes("跨平台合法"), "项目名拒绝 Windows 不允许的末尾句点");
	}

	// 4. pending：语义正确、忽略于 git、拒绝原因进入会话审计。
	result = await remember({ title: "待审测试", description: "待审核候选测试", body: "待审正文。", tags: ["测试"], zone: "personal", layer: "principles", type: "Principle", as_pending: true });
	assert(toolText(result).includes("待审核候选"), "可以创建待审核候选");
	let pending = pendingFiles()[0];
	const pendingPath = path.join(REPO, "pending", pending);
	let pendingText = fs.readFileSync(pendingPath, "utf8");
	assert(pendingText.includes("status: pending") && pendingText.includes("reviewed: false"), "pending 不冒充正式已审核记忆");
	if (process.platform !== "win32") assert((fs.statSync(pendingPath).mode & 0o777) === 0o600, "pending 使用仅当前用户可读写的权限");
	assert((await git(["status", "--porcelain"])).stdout.trim() === "", "pending 文件不会污染 git 状态");
	await commands.memory.handler("review", ctx);
	await commands.memory.handler(`reject ${pending.replace(/\.md$/, "")} 测试拒绝`, ctx);
	assert(pendingFiles().length === 0, "拒绝后删除 pending");
	assert(entries.some((entry) => entry.customType === "memark-rejection" && entry.data.reason === "测试拒绝"), "拒绝原因写入会话审计");

	const noUiCtx = { hasUI: false, ui: { confirm: async () => false, notify: () => {} }, cwd: "/workspace/none" };
	result = await remember({ title: "无界面候选", description: "验证无界面模式只写 pending", body: "无界面正文。", tags: ["测试"], zone: "personal", layer: "principles", type: "Principle" }, noUiCtx);
	assert(toolText(result).includes("待审核候选") && pendingFiles().length === 1, "无界面模式不会正式提交");
	fs.rmSync(path.join(REPO, "pending", pendingFiles()[0]));

	const fakeSecret = "gh" + "p_" + "A".repeat(30);
	try {
		await remember({ title: "敏感候选", description: "应被拒绝", body: fakeSecret, tags: ["测试"], zone: "personal", layer: "principles", type: "Principle", as_pending: true });
		assert(false, "含疑似密钥的 pending 应失败");
	} catch (error) {
		assert(String(error.message).includes("敏感信息"), "pending 写入前执行敏感信息检查");
	}

	try {
		await remember({ title: "能不动就不动", description: "重复文件", body: "x", tags: ["测试"], zone: "personal", layer: "principles", type: "Principle" });
		assert(false, "同名正式记忆应失败");
	} catch (error) {
		assert(String(error.message).includes("已存在"), "同名文件守卫生效");
	}

	// 5. 正式写入：确认前不触碰正式目录；只提交计划文件；选项为 Yes / No / Edit。
	const formalRel = "projects/wiki/topics/正式写入测试.md";
	let checkedBeforeConfirm = false;
	let selectOptionsSeen = null;
	selectImpl = async (title, options) => {
		selectOptionsSeen = options;
		checkedBeforeConfirm = !fs.existsSync(path.join(REPO, formalRel));
		assert(previewTitles.join("\n").includes(formalRel) && previewTitles.join("\n").includes("+status: active"), "确认前已分页展示真实 diff");
		assert(title.length < 80, "最终批准标题不携带长 diff");
		return "Yes";
	};
	result = await remember({ title: "正式写入测试", description: "验证安全正式写入流程", body: "正式正文。", tags: ["测试"], zone: "project", project: "wiki", category: "topics", type: "Topic" });
	selectImpl = async () => "Yes";
	assert(checkedBeforeConfirm, "用户确认前正式目录没有草案");
	assert(JSON.stringify(selectOptionsSeen) === JSON.stringify(["Yes", "No", "Edit"]), "确认选项为 Yes / No / Edit");
	assert(toolText(result).startsWith("✓"), "正式写入成功");
	assert(fs.existsSync(path.join(REPO, formalRel)), "正式文件已创建");
	assert(fs.readFileSync(path.join(REPO, "projects/wiki/INDEX.md"), "utf8").includes("正式写入测试"), "项目索引已更新");
	let commitFiles = (await git(["show", "--name-only", "--format=", "HEAD"])).stdout;
	assert(!commitFiles.includes("pending/"), "正式 commit 不包含 pending 文件");
	assert((await git(["status", "--porcelain"])).stdout.trim() === "", "正式写入后工作区干净");

	result = await remember({ title: "新项目首条决策", description: "验证新项目自动建立路由", body: "新项目正文。", tags: ["测试"], zone: "project", project: "newproject", category: "decisions", type: "Decision" });
	assert(toolText(result).startsWith("✓"), "可以写入尚未建立项目区的新项目");
	assert(fs.existsSync(path.join(REPO, "projects/newproject/README.md")) && fs.existsSync(path.join(REPO, "projects/newproject/INDEX.md")), "新项目自动建立 README 和 INDEX");

	// 5b. category 可省略：项目区与个人区 knowledge 按 type 自动归档；变体自动归一化。
	result = await remember({ title: "自动归档决策", description: "省略 category 的项目区写入", body: "自动归档正文。", tags: ["测试"], zone: "project", project: "wiki", type: "Decision" });
	assert(toolText(result).startsWith("✓") && fs.existsSync(path.join(REPO, "projects/wiki/decisions/自动归档决策.md")), "项目区省略 category 时按 type 自动归档");
	result = await remember({ title: "自动归档技能", description: "省略 category 的 knowledge 写入", body: "技能正文。", tags: ["测试"], zone: "personal", layer: "knowledge", type: "Skill" });
	assert(toolText(result).startsWith("✓") && fs.existsSync(path.join(REPO, "knowledge/skills/自动归档技能.md")), "个人区 knowledge 省略 category 时按 type 自动归档");
	const curatorMod = jiti(path.join(__dirname, "..", "curator.ts"));
	assert(JSON.stringify(tools.memark_remember.parameters.properties.category.enum) === JSON.stringify(["current", "relationships"]), "模型 schema 不再混合个人区和项目区 category");
	const categoryBase = { title: "分类兼容测试", description: "虚构分类测试", body: "分类测试正文。", tags: ["测试"], zone: "project", project: "wiki", as_pending: true };
	for (const [type, category, directory] of [["Decision", "Decisions", "decisions"], ["Topic", "Topic ", "topics"], ["Incident", "INCIDENT", "incidents"], ["Handoff", "handoff", "handoffs"]]) {
		const args = { ...categoryBase, type, category, ...(type === "Handoff" ? { expires: "2099-01-01" } : {}) };
		const original = JSON.stringify(args);
		const prepared = tools.memark_remember.prepareArguments(args);
		assert(prepared.category === undefined && JSON.stringify(args) === original, `${type} 旧 category 兼容并移除冗余字段，不修改原参数`);
		result = await remember(args);
		assert(toolText(result).includes(`projects/wiki/${directory}/`), `${type} 经真实 wrapper/prepare/schema 链正确归档`);
		fs.rmSync(path.join(REPO, "pending", pendingFiles()[0]));
	}
	assert(curatorMod.resolveTargetPath({ ...categoryBase, type: "Topic", category: "Topic " }).path.endsWith("topics/分类兼容测试.md"), "直接调用路径解析也使用同一归一化入口");
	for (const [type, category, directory] of [["Skill", "SKILL", "skills"], ["Experience", "Experience ", "experiences"], ["Learning", "learnings", "learnings"]]) {
		result = await remember({ title: "个人分类兼容", description: "测试个人类型推导", body: "测试。", tags: ["测试"], zone: "personal", type, category, as_pending: true });
		assert(toolText(result).includes(`knowledge/${directory}/`), `${type} 不需要 layer/category 重复选择`);
		fs.rmSync(path.join(REPO, "pending", pendingFiles()[0]));
	}
	result = await remember({ title: "关系分类兼容", description: "测试 Context", body: "关系测试。", tags: ["测试"], zone: "personal", type: "Context", category: "Relationship ", as_pending: true });
	assert(toolText(result).includes("context/relationships/"), "Context 仍可选择关系分类");
	fs.rmSync(path.join(REPO, "pending", pendingFiles()[0]));
	for (const invalid of [
		{ ...categoryBase, type: "Topic", category: "skills" },
		{ ...categoryBase, type: "Decision", category: "topics" },
		{ ...categoryBase, type: "Skill" },
		{ ...categoryBase, type: "Topic", layer: "knowledge" },
		{ ...categoryBase, zone: "personal", type: "Topic" },
	]) {
		let error;
		try { await remember(invalid); } catch (err) { error = err; }
		assert(error && error.message.includes("分类冲突"), "真正的范围/类型冲突被明确拒绝，不静默改区");
	}
	assert(pendingFiles().length === 0 && (await git(["status", "--porcelain"])).stdout.trim() === "", "非法分类不留下候选或正式改动");

	// 5b-UI. 新项目多文件长预览：真实 ReviewPanel 渲染和按键经过工具的完整流程。
	const { getKeybindings } = await import(pathToFileURL(tuiEntry).href);
	const uiDraft = { title: "多文件长预览", description: "新项目界面回归", body: "长正文测试\n".repeat(6000) + "BODY_END_SENTINEL", tags: ["测试"], zone: "project", project: "ui-project", type: "Topic" };
	const beforeUiHead = (await git(["rev-parse", "HEAD"])).stdout;
	const tuiContext = (choice) => ({ ...ctx, mode: "tui", ui: { ...ctx.ui, custom: async (factory, options) => {
		let chosen;
		const component = await factory({ terminal: { rows: 24 }, requestRender() {} }, { fg: (_color, text) => text, bold: (text) => text }, getKeybindings(), (value) => { chosen = value; });
		const lines = component.render(78);
		assert(options.overlay && ["Yes", "No", "Edit"].every((option) => lines.some((line) => line.includes(option))), "新项目真实预览的三个操作始终可见");
		assert(lines.join("").includes("新建项目") && lines.join("").includes("辅助文件"), "预览显著区分新项目和辅助文件");
		assert(!fs.existsSync(path.join(REPO, "projects/ui-project")), "显示审核窗口时正式项目目录尚未创建");
		component.handleInput("\x1b[F");
		let tailVisible = false;
		for (let page = 0; page < 8; page++) {
			tailVisible ||= component.render(78).some((line) => line.includes("BODY_END_SENTINEL"));
			component.handleInput("\x1b[5~");
		}
		assert(tailVisible, "真实多文件 diff 超过 30000 字仍完整可达");
		component.handleInput(choice === "Yes" ? "1" : "2"); component.handleInput("\r"); component.dispose();
		return chosen;
	} } });
	result = await remember(uiDraft, tuiContext("No"));
	assert(toolText(result).includes("已取消") && !fs.existsSync(path.join(REPO, "projects/ui-project")), "No 不留下记忆、README、INDEX 或项目目录");
	assert((await git(["rev-parse", "HEAD"])).stdout === beforeUiHead, "取消新项目不会产生提交");
	result = await remember(uiDraft, tuiContext("Yes"));
	assert(toolText(result).startsWith("✓"), "新项目长预览经真实按键批准后写入");
	commitFiles = (await git(["show", "--name-only", "--format=", "HEAD"])).stdout.trim().split("\n");
	assert(commitFiles.length === 3 && commitFiles.includes("projects/ui-project/README.md") && commitFiles.includes("projects/ui-project/INDEX.md"), "一条记忆与两个辅助文件位于同一精确提交");

	const unsupported = { ...ctx, mode: "tui", ui: { ...ctx.ui, custom: undefined } };
	result = await remember({ ...uiDraft, project: "unavailable-ui", title: "界面不可用候选", body: "仅待审核。" }, unsupported);
	assert(toolText(result).includes("待审核候选") && !fs.existsSync(path.join(REPO, "projects/unavailable-ui")), "不支持安全 UI 时仅存 pending，不降级长标题确认");
	fs.rmSync(path.join(REPO, "pending", pendingFiles()[0]));
	const abort = new AbortController();
	selectImpl = async () => { abort.abort(); return "Yes"; };
	result = await remember({ ...categoryBase, type: "Topic", title: "中断保护测试", as_pending: false }, { ...ctx, signal: abort.signal }, abort.signal);
	selectImpl = async () => "Yes";
	assert(toolText(result).includes("已取消") && !fs.existsSync(path.join(REPO, "projects/wiki/topics/中断保护测试.md")), "审核中断后即使客户端返回 Yes 也不写入");
	assert(!fs.existsSync(path.join(REPO, ".git/memark-write.lock")), "中断会释放仓库锁");
	result = await remember({ ...categoryBase, type: "Topic", title: "RPC超时待审", as_pending: false }, { ...ctx, ui: { ...ctx.ui, select: async () => undefined } });
	assert(toolText(result).includes("待审核候选") && !fs.existsSync(path.join(REPO, "projects/wiki/topics/RPC超时待审.md")), "RPC 关闭或超时保留 pending，不丢失草案或默认批准");
	fs.rmSync(path.join(REPO, "pending", pendingFiles()[0]));
	const previewFailureTools = {};
	curatorMod.registerCurator({ ...pi,
		registerTool: (definition) => { previewFailureTools[definition.name] = definition; },
		exec: (cmd, args, opts) => cmd === "git" && args.includes("--no-index")
			? Promise.resolve({ code: 1, killed: true, stdout: "@@ incomplete @@\n+ partial", stderr: "timeout" }) : exec(cmd, args, opts),
	});
	let unsafeReviewCalled = false;
	result = await previewFailureTools.memark_remember.execute("diff-timeout", { ...categoryBase, type: "Topic", title: "预览失败待审", as_pending: false }, undefined, undefined,
		{ ...ctx, ui: { ...ctx.ui, select: async () => { unsafeReviewCalled = true; return "Yes"; } } });
	assert(!unsafeReviewCalled && toolText(result).includes("待审核候选"), "Git diff 超时产生的部分输出不得进入批准界面");
	fs.rmSync(path.join(REPO, "pending", pendingFiles()[0]));

	// 5b-route. 在同一审核流程修改归属；旧项目 scaffold 不能混入新预览和提交。
	let routeStep = 0;
	editMenuImpl = async () => "修改归属";
	selectImpl = async (title) => {
		if (title === "memark：适用范围") return "个人区（跨项目）";
		if (title === "memark：选择新范围下的记忆类型") return "Principle";
		return routeStep++ === 0 ? "Edit" : "Yes";
	};
	result = await remember({ ...categoryBase, project: "discarded-project", type: "Topic", title: "归属调整测试", as_pending: false });
	editMenuImpl = async () => "修改措辞";
	selectImpl = async () => "Yes";
	assert(toolText(result).includes("principles/归属调整测试.md") && !fs.existsSync(path.join(REPO, "projects/discarded-project")), "用户改归个人区后只提交新计划，不残留原项目");
	const relocated = fs.readFileSync(path.join(REPO, "principles/归属调整测试.md"), "utf8");
	assert(relocated.includes("type: Principle") && !relocated.includes("scope: project"), "跨区类型由用户重选，scope 同步调整");
	assert((await git(["log", "-1", "--format=%s"])).stdout.includes("memory: principles/归属调整测试.md"), "审计提交使用最终批准的目标路径");

	// 编辑/调整归属后同步或工作区变化，pending 必须保留最后审核草案，而非旧参数。
	const lateDirtyFile = path.join(REPO, "principles/清理前先备份.md");
	routeStep = 0;
	let editMenuStep = 0;
	editMenuImpl = async () => editMenuStep++ === 0 ? "修改措辞" : "修改归属";
	editorImpl = async (_title, text) => text.replace("分类测试正文。", "已经由用户调整的新正文。");
	selectImpl = async (title) => {
		if (title === "memark：适用范围") return "个人区（跨项目）";
		if (title === "memark：选择新范围下的记忆类型") return "Principle";
		if (routeStep++ < 2) return "Edit";
		fs.appendFileSync(lateDirtyFile, "\nLATE_DIRTY_FIXTURE\n");
		return "Yes";
	};
	result = await remember({ ...categoryBase, project: "deferred-project", type: "Topic", title: "归属调整待审测试", description: "编辑后变化的候选恢复测试", as_pending: false });
	selectImpl = async () => "Yes"; editMenuImpl = async () => "修改措辞"; editorImpl = async () => undefined;
	pending = pendingFiles()[0];
	pendingText = fs.readFileSync(path.join(REPO, "pending", pending), "utf8");
	assert(toolText(result).includes("待审核候选") && pendingText.includes("target: principles/归属调整待审测试.md") && pendingText.includes("已经由用户调整的新正文"), "降级 pending 保留修改后的正文、类型与目标");
	assert(!fs.existsSync(path.join(REPO, "projects/deferred-project")) && pendingText.includes("reviewed: false"), "降级不创建旧项目或伪装已批准");
	await git(["restore", "--", "principles/清理前先备份.md"]);
	await commands.memory.handler(`approve ${pending.replace(/\.md$/, "")}`, ctx);
	assert(fs.existsSync(path.join(REPO, "principles/归属调整待审测试.md")) && pendingFiles().length === 0, "变更后的 pending 可再次完整审核并批准");

	// 5c. Edit 选项：编辑后写入；Esc 返回预览；破坏格式时提示并不写入。
	let editStep = 0;
	selectImpl = async () => (editStep++ === 0 ? "Edit" : "Yes");
	editorImpl = async (_title, prefill) => String(prefill).replace("编辑前正文。", "编辑后正文。");
	result = await remember({ title: "编辑流程测试", description: "验证 Edit 选项", body: "编辑前正文。", tags: ["测试"], zone: "personal", layer: "principles", type: "Principle" });
	selectImpl = async () => "Yes";
	editorImpl = async () => undefined;
	assert(toolText(result).startsWith("✓") && fs.readFileSync(path.join(REPO, "principles/编辑流程测试.md"), "utf8").includes("编辑后正文。"), "Edit 编辑草案后确认写入");

	editStep = 0;
	selectImpl = async () => (editStep++ === 0 ? "Edit" : "No");
	result = await remember({ title: "编辑取消测试", description: "验证 Esc 返回预览", body: "取消正文。", tags: ["测试"], zone: "personal", layer: "principles", type: "Principle" });
	selectImpl = async () => "Yes";
	assert(!fs.existsSync(path.join(REPO, "principles/编辑取消测试.md")) && toolText(result).includes("已取消"), "编辑器 Esc 返回预览后可取消");

	editStep = 0;
	const editTitles = [];
	selectImpl = async (title) => { editTitles.push(String(title)); return editStep++ === 0 ? "Edit" : "No"; };
	editorImpl = async (_title, prefill) => String(prefill).replace(/^---[\s\S]*?---/, "损坏的 frontmatter");
	result = await remember({ title: "编辑失败测试", description: "验证校验失败的编辑", body: "失败正文。", tags: ["测试"], zone: "personal", layer: "principles", type: "Principle" });
	selectImpl = async () => "Yes";
	editorImpl = async () => undefined;
	assert(previewTitles.some((title) => title.includes("编辑未通过")), "破坏格式的编辑在预览中提示错误");
	assert(!fs.existsSync(path.join(REPO, "principles/编辑失败测试.md")), "校验失败的编辑不会写入");

	// 5d. /memory edit 与 memark_remember edit 参数：原地修改措辞。
	const editTarget = "principles/编辑流程测试.md";
	editorImpl = async (_title, prefill) => String(prefill).replace("编辑后正文。", "命令行编辑正文。");
	await commands.memory.handler(`edit ${editTarget}`, ctx);
	editorImpl = async () => undefined;
	assert(fs.readFileSync(path.join(REPO, editTarget), "utf8").includes("命令行编辑正文。"), "/memory edit 原地更新记忆");
	commitFiles = (await git(["show", "--name-only", "--format=", "HEAD"])).stdout;
	assert(commitFiles.includes("编辑流程测试.md") && !commitFiles.includes("pending/"), "edit 的 commit 只包含该记忆");
	assert((await git(["status", "--porcelain"])).stdout.trim() === "", "edit 后工作区干净");

	result = await remember({ title: "编辑流程测试", description: "更新后的描述", body: "模型改写正文。", tags: ["测试"], zone: "personal", layer: "principles", type: "Principle", edit: editTarget });
	assert(toolText(result).startsWith("✓"), "memark_remember edit 参数原地改写");
	const editedText = fs.readFileSync(path.join(REPO, editTarget), "utf8");
	assert(editedText.includes("模型改写正文。") && editedText.includes("更新后的描述"), "edit 参数更新正文与描述");
	assert(editedText.includes("type: Principle") && /^timestamp: \d{4}-\d{2}-\d{2}$/m.test(editedText), "edit 参数保留原 type 与 timestamp");

	// 6. approve：pending 不进入 commit，批准后仓库保持干净。
	await remember({ title: "批准流程测试", description: "验证 pending approve", body: "批准正文。\ntarget: 正文中的普通文本", tags: ["测试"], zone: "personal", layer: "principles", type: "Principle", as_pending: true });
	pending = pendingFiles()[0];
	await commands.memory.handler(`approve ${pending.replace(/\.md$/, "")}`, ctx);
	const approvedPath = path.join(REPO, "principles/批准流程测试.md");
	assert(fs.existsSync(approvedPath), "approve 生成正式记忆");
	assert(fs.readFileSync(approvedPath, "utf8").includes("target: 正文中的普通文本"), "approve 只移除 frontmatter 的 target，不误删正文");
	assert(pendingFiles().length === 0, "approve 后删除本地 pending");
	commitFiles = (await git(["show", "--name-only", "--format=", "HEAD"])).stdout;
	assert(!commitFiles.includes("pending/"), "approve 的 commit 不包含 pending");
	assert((await git(["status", "--porcelain"])).stdout.trim() === "", "approve 后工作区干净");

	// 6b. approve 前可先编辑措辞。
	await remember({ title: "批准编辑测试", description: "验证批准前编辑", body: "批准前正文。", tags: ["测试"], zone: "personal", layer: "principles", type: "Principle", as_pending: true });
	pending = pendingFiles()[0];
	let approveStep = 0;
	selectImpl = async () => (approveStep++ === 0 ? "Edit" : "Yes");
	editorImpl = async (_title, prefill) => String(prefill).replace("批准前正文。", "批准时编辑正文。");
	await commands.memory.handler(`approve ${pending.replace(/\.md$/, "")}`, ctx);
	selectImpl = async () => "Yes";
	editorImpl = async () => undefined;
	assert(fs.readFileSync(path.join(REPO, "principles/批准编辑测试.md"), "utf8").includes("批准时编辑正文。"), "approve 支持批准前编辑措辞");
	await remember({ title: "批准延迟保留草案", description: "批准流程延迟的草案保护", body: "延迟前正文。", tags: ["测试"], zone: "personal", type: "Principle", as_pending: true });
	pending = pendingFiles()[0]; approveStep = 0;
	selectImpl = async () => {
		if (approveStep++ === 0) return "Edit";
		fs.appendFileSync(lateDirtyFile, "\nAPPROVE_DIRTY_FIXTURE\n");
		return "Yes";
	};
	editorImpl = async (_title, prefill) => String(prefill).replace("延迟前正文。", "用户编辑后待审正文。").replace(/\r?\n/g, "\r\n");
	await commands.memory.handler(`approve ${pending.replace(/\.md$/, "")}`, ctx);
	selectImpl = async () => "Yes"; editorImpl = async () => undefined;
	pendingText = fs.readFileSync(path.join(REPO, "pending", pending), "utf8");
	assert(pendingText.includes("target: principles/批准延迟保留草案.md") && pendingText.includes("用户编辑后待审正文") && !fs.existsSync(path.join(REPO, "principles/批准延迟保留草案.md")), "approve 延迟时更新原 pending，CRLF 草案也保留 target 和最新措辞");
	await git(["restore", "--", "principles/清理前先备份.md"]);
	await commands.memory.handler(`approve ${pending.replace(/\.md$/, "")}`, ctx);
	assert(pendingFiles().length === 0, "延迟草案恢复后可重新批准");

	// 7. supersedes 同 commit 更新旧状态。
	result = await remember({ title: "最小改动原则新版", description: "取代旧版最小改动原则", body: "使用新版原则。", tags: ["测试"], zone: "personal", layer: "principles", type: "Principle", supersedes: "principles/能不动就不动.md" });
	assert(toolText(result).startsWith("✓"), "supersedes 写入成功");
	assert(fs.readFileSync(path.join(REPO, "principles/能不动就不动.md"), "utf8").includes("status: superseded"), "旧记忆标记为 superseded");
	commitFiles = (await git(["show", "--name-only", "--format=", "HEAD"])).stdout;
	assert(commitFiles.includes("最小改动原则新版.md") && commitFiles.includes("能不动就不动.md"), "新旧状态位于同一个 commit");

	const raceWriter = path.join(BASE, "remote-writer");
	selectImpl = async () => {
		shell(`git -C "${raceWriter}" pull -q --ff-only`);
		const raceFile = path.join(raceWriter, "preferences", "确认期间远端更新.md");
		fs.writeFileSync(raceFile, `---\ntype: Preference\ntitle: 确认期间远端更新\ndescription: 验证确认期间远端变化会停止旧预览提交\nstatus: active\nprivacy: internal\ntags: [同步, 测试]\ntimestamp: 2026-09-22\nsource: user-confirmed\nreviewed: true\n---\n\n远端竞态测试。\n`);
		shell(`python3 "${raceWriter}/scripts/generate_index.py" --root "${raceWriter}"`);
		shell(`git -C "${raceWriter}" add -- preferences/确认期间远端更新.md INDEX.md`);
		shell(`git -C "${raceWriter}" commit -q -m "memory: remote race fixture"`);
		shell(`git -C "${raceWriter}" push -q`);
		return "Yes";
	};
	result = await remember({ title: "远端竞态保护测试", description: "远端变化时不使用旧预览提交", body: "应降级待审。", tags: ["测试"], zone: "personal", layer: "principles", type: "Principle" });
	selectImpl = async () => "Yes";
	assert(!fs.existsSync(path.join(REPO, "principles/远端竞态保护测试.md")), "确认期间远端变化时不写入旧草案");
	assert(toolText(result).includes("待审核候选") && pendingFiles().length === 1, "远端变化时降级保存 pending");
	fs.rmSync(path.join(REPO, "pending", pendingFiles()[0]));

	// 8. 仓库已有手工修改时停止，不删除修改，并把新请求降级为 pending。
	const protectedFile = path.join(REPO, "principles/清理前先备份.md");
	fs.appendFileSync(protectedFile, "\nUNCOMMITTED_SENTINEL\n");
	result = await remember({ title: "脏仓库保护测试", description: "验证不会覆盖手工修改", body: "保护正文。", tags: ["测试"], zone: "personal", layer: "principles", type: "Principle" });
	assert(fs.readFileSync(protectedFile, "utf8").includes("UNCOMMITTED_SENTINEL"), "失败流程保留用户未提交修改");
	assert(toolText(result).includes("待审核候选"), "仓库有修改时自动降级为 pending");
	shell(`git -C "${REPO}" checkout -- principles/清理前先备份.md`);
	for (const file of pendingFiles()) fs.rmSync(path.join(REPO, "pending", file));
	assert((await git(["status", "--porcelain"])).stdout.trim() === "", "清理测试状态后仓库干净");

	// 9. 路径越界攻击不能删除外部文件。
	const outside = path.join(BASE, "outside.md");
	fs.writeFileSync(outside, "outside sentinel\n");
	await commands.memory.handler("forget ../outside.md", ctx);
	assert(fs.existsSync(outside), "forget 拒绝记忆库外路径");
	const malicious = path.join(REPO, "pending", "malicious.md");
	fs.writeFileSync(malicious, `---\ntarget: ../outside.md\ntitle: malicious\n---\nbody\n`);
	await commands.memory.handler("approve malicious", ctx);
	assert(fs.existsSync(outside) && !fs.existsSync(path.join(BASE, "outside.md.md")), "approve 拒绝恶意 target 路径");
	fs.rmSync(malicious);

	// 10. 正常归档保留原目录结构，随后安全撤销。
	await commands.memory.handler(`forget ${formalRel}`, ctx);
	assert(!fs.existsSync(path.join(REPO, formalRel)), "归档后原文件移除");
	assert(fs.existsSync(path.join(REPO, "archive", formalRel)), "archive 保留原相对目录，避免同名冲突");
	await commands.memory.handler("revert", ctx);
	assert(fs.existsSync(path.join(REPO, formalRel)), "revert 恢复最近一次归档");
	assert(!fs.existsSync(path.join(REPO, "archive", formalRel)), "revert 清除对应归档副本");

	// 11. commit hook 失败时只恢复本次文件，不留暂存内容。
	const failingHooks = path.join(BASE, "failing-hooks");
	fs.mkdirSync(failingHooks);
	fs.writeFileSync(path.join(failingHooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	await git(["config", "core.hooksPath", failingHooks]);
	result = await remember({ title: "提交失败回滚测试", description: "验证精确回滚", body: "不会残留。", tags: ["测试"], zone: "personal", layer: "principles", type: "Principle" });
	await git(["config", "core.hooksPath", ".githooks"]);
	assert(toolText(result).startsWith("✗"), "commit 失败被报告");
	assert(!fs.existsSync(path.join(REPO, "principles/提交失败回滚测试.md")), "commit 失败后移除本次新文件");
	assert((await git(["status", "--porcelain"])).stdout.trim() === "", "commit 失败后工作区和暂存区干净");

	// 12. 同时发起的两次写入会排队，不互相覆盖。
	const [parallelA, parallelB] = await Promise.all([
		remember({ title: "串行写入甲", description: "并发测试甲", body: "甲。", tags: ["测试"], zone: "personal", layer: "principles", type: "Principle" }),
		remember({ title: "串行写入乙", description: "并发测试乙", body: "乙。", tags: ["测试"], zone: "personal", layer: "principles", type: "Principle" }),
	]);
	assert(toolText(parallelA).startsWith("✓") && toolText(parallelB).startsWith("✓"), "并发写入按顺序完成");
	assert((await git(["status", "--porcelain"])).stdout.trim() === "", "并发写入后仓库干净");

	// 13. sync：远端手工改正文但漏更索引时，只修复索引，不夹带其他文件。
	const remoteWriter = path.join(BASE, "remote-writer");
	shell(`git -C "${remoteWriter}" pull -q --ff-only`);
	shell(`git -C "${remoteWriter}" config core.hooksPath /dev/null`);
	const remoteFile = path.join(remoteWriter, "principles", "清理前先备份.md");
	fs.writeFileSync(remoteFile, fs.readFileSync(remoteFile, "utf8").replace("删除数据前必须备份；批量操作先 dry-run 确认后执行", "删除前必须备份；破坏性操作先预览"));
	shell(`git -C "${remoteWriter}" add -- principles/清理前先备份.md`);
	shell(`git -C "${remoteWriter}" commit -q -m "manual edit simulation"`);
	shell(`git -C "${remoteWriter}" push -q`);
	await commands.memory.handler("sync", ctx);
	assert(fs.readFileSync(path.join(REPO, "INDEX.md"), "utf8").includes("破坏性操作先预览"), "sync 修复远端遗漏的索引更新");
	commitFiles = (await git(["show", "--name-only", "--format=", "HEAD"])).stdout.trim();
	assert(commitFiles === "INDEX.md", "sync 修复 commit 只包含索引");
	assert((await git(["status", "--porcelain"])).stdout.trim() === "", "sync 后仓库干净");

	// 14. maintain 与 status 可执行，fixture 完全独立于私人 memory 仓库。
	await commands.memory.handler("maintain", ctx);
	await commands.memory.handler("status", ctx);
	assert(notes.some((note) => note.includes("维护检查通过")), "maintain 完成只读检查");
	const bareHead = shell(`git -C "${BARE}" rev-parse main`).trim();
	const localHead = (await git(["rev-parse", "HEAD"])).stdout.trim();
	assert(bareHead === localHead, "全部成功提交均已推送到隔离远端");

	console.log("\n全部 memark 回归测试通过");
})().catch((error) => {
	console.error("HARNESS ERROR:", error);
	process.exit(1);
});
