/* 真实 Pi 渲染组件测试，不读私人记忆、不启动模型或终端。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createRequire } = require("node:module");
const G = process.env.PI_NODE_MODULES;
const sdk = process.env.MEMARK_TEST_PI_ROOT || path.resolve(G, "..");
const tuiRoot = path.dirname(path.dirname(createRequire(path.join(sdk, "package.json")).resolve("@earendil-works/pi-tui")));
const { createJiti } = createRequire(path.resolve(G, "../package.json"))("jiti");
const jiti = createJiti(__filename, { alias: { "@earendil-works/pi-tui": path.join(tuiRoot, "dist/index.js") } });
const { ReviewPanel, showReview, displayText } = jiti(path.join(__dirname, "../review-ui.ts"));
const { captureRuntime } = jiti(path.join(__dirname, "../diagnostics.ts"));
const load = (file) => import(pathToFileURL(file).href);

(async () => {
	const { TuiMainScreen, TuiAltScreen, Container, Text, visibleWidth } = await load(path.join(tuiRoot, "dist/index.js"));
	const { renderLayoutFrame } = await load(path.join(tuiRoot, "dist/layout.js"));
	const { KeybindingsManager } = await load(path.join(sdk, "dist/core/keybindings.js"));
	const { initTheme, theme } = await load(path.join(sdk, "dist/modes/interactive/theme/theme.js"));
	const { ExtensionSelectorComponent } = await load(path.join(sdk, "dist/modes/interactive/components/extension-selector.js"));
	const { createChatViewport } = await load(path.join(sdk, "dist/modes/interactive/chat-viewport.js"));
	initTheme("dark");
	const kb = new KeybindingsManager();
	const optionsVisible = (lines) => ["Yes", "No", "Edit"].every((name) => lines.some((line) => line.includes(name)));
	const longText = "FIRST_SENTINEL\n" + "中文长路径和正文👩‍💻 e\u0301 文本测试 ".repeat(6000) + "\nLAST_SENTINEL";
	const review = { title: "memark：确认以下修改？", summary: "项目区：虚构项目（新建项目）；1 个记忆文件 + 2 个辅助文件。\n目标：projects/虚构项目/topics/测试.md", text: longText, canEdit: true };

	// 锁定原故障：长标题在真实 fullscreen dock 中挤掉全部按钮。
	const oldSelector = new ExtensionSelectorComponent("旧预览\n" + "diff 行\n".repeat(40), ["Yes", "No", "Edit"], () => {}, () => {});
	const editor = new Container(); editor.addChild(oldSelector);
	const oldViewport = createChatViewport({ document: new Text("fixture"), pendingMessages: new Container(), status: new Container(), editor, footer: new Container() });
	assert(!optionsVisible(renderLayoutFrame(oldViewport.root, 80, 24, () => {}).lines));
	console.log("✓ 真实 Pi 布局复现旧长标题按钮消失");

	for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
		const terminal = { rows: 24, columns: 80, write() {}, start() {}, stop() {}, hideCursor() {}, showCursor() {} };
		const tui = new Renderer(terminal);
		const results = [];
		const panel = new ReviewPanel(review, tui, theme, kb, (choice) => results.push(choice));
		const overlay = tui.showOverlay(panel, { width: "100%", maxHeight: "100%", margin: 1 });
		for (const [width, height] of [[80, 24], [120, 40], [40, 16], [26, 14], [160, 45], [80, 24]]) {
			terminal.rows = height; terminal.columns = width;
			for (const key of ["\x1b[H", "\x1b[6~", "\x1b[F", "\x1b[5~"]) {
				panel.render(width - 2);
				panel.handleInput(key);
				// 使用两个 renderer 的真实 overlay 合成器，而非只检查传入的选项数组。
				const screen = tui.compositeOverlays(Array(height).fill(""), width, height);
				assert(optionsVisible(screen), `${tui.mode} ${width}x${height}: 三键必须可见`);
				assert(screen.length <= height);
				assert(screen.every((line) => !/[\r\n]/.test(line) && visibleWidth(line) <= width));
			}
		}
		panel.handleInput("\x1b[F");
		assert(panel.render(78).some((line) => line.includes("LAST_SENTINEL")), "超过 30000 字的尾部可以滚动到达");
		panel.handleInput("\x1b[H");
		assert(panel.render(78).some((line) => line.includes("FIRST_SENTINEL")));
		panel.handleInput("\r");
		assert.deepEqual(results, ["Yes"], "按用户要求默认 Yes，Enter 显式批准");
		overlay.hide(); panel.dispose();
		console.log(`✓ ${tui.mode}：长预览、中文宽字、缩放、分页、完整尾部与固定操作区`);
	}

	const fakeTui = { terminal: { rows: 24 }, requestRender() {} };
	for (const [keys, expected] of [[["\r"], "Yes"], [["1", "\r"], "Yes"], [["2", "\r"], "No"], [["3", "\r"], "Edit"], [["\x1b"], "No"]]) {
		const results = [];
		const panel = new ReviewPanel(review, fakeTui, theme, kb, (choice) => results.push(choice));
		const rendered = panel.render(80);
		const actionRows = ["1 Yes", "2 No", "3 Edit"].map((label) => rendered.findIndex((line) => line.includes(label)));
		assert(actionRows[0] >= 0 && actionRows[0] < actionRows[1] && actionRows[1] < actionRows[2], "TUI 按 Yes / No / Edit 排列");
		assert(rendered[actionRows[0]].includes("→"), "初始焦点位于 Yes");
		assert.deepEqual(results, [], "默认选中不等于自动批准");
		for (const key of keys) panel.handleInput(key);
		assert.deepEqual(results, [expected]); panel.dispose();
	}
	let result;
	const controller = new AbortController();
	const panel = new ReviewPanel(review, fakeTui, theme, kb, (choice) => { result = choice; }, controller.signal);
	panel.render(80); panel.handleInput("1");
	fakeTui.terminal.rows = 8; panel.render(20); panel.handleInput("\r");
	assert.equal(result, undefined, "过小窗口禁止盲批准");
	controller.abort(); panel.handleInput("\r"); assert.equal(result, "No"); panel.dispose();
	fakeTui.terminal.rows = 24;
	assert.equal(displayText("\x1b[2J\r\n\u202e"), "\\u001b[2J\n\\u202e");
	console.log("✓ Yes/No/Edit 顺序、默认选中 Yes、显式确认、小屏保护与取消");

	let customCalls = 0, viewCalls = 0, finalCalls = 0;
	const rpc = { hasUI: true, mode: "rpc", ui: {
		custom: () => { customCalls++; throw new Error("RPC must not use custom"); },
		editor: async (title, prefill) => {
			viewCalls++;
			assert(title.length < 80 && !title.includes("\n"));
			assert(prefill.includes("FIRST_SENTINEL") && prefill.includes("LAST_SENTINEL"));
			assert(prefill.length > 30000, "完整长预览不截断、不放入标题");
			return prefill;
		},
		select: async (title, options) => {
			finalCalls++; assert.equal(title.split("\n").length, 1);
			assert.deepEqual(options, ["Yes", "No", "Edit", "重看完整预览"]); return "Yes";
		},
	} };
	assert.equal(await showReview(rpc, review), "Yes");
	assert.equal(customCalls, 0); assert.equal(viewCalls, 1); assert.equal(finalCalls, 1);
	let revisit = 0;
	assert.equal(await showReview({ ...rpc, ui: { ...rpc.ui, select: async () => revisit++ === 0 ? "重看完整预览" : "No" } }, review), "No");
	assert.equal(viewCalls, 3, "可主动重看，但不强制数百次翻页");
	assert.equal(await showReview({ ...rpc, ui: { ...rpc.ui, select: async (_title, options) => options[0] } }, review), "Yes");
	assert.equal(await showReview({ ...rpc, ui: { ...rpc.ui, select: async () => "Edit" } }, review), "Edit");
	assert.equal(await showReview({ ...rpc, ui: { ...rpc.ui, select: async () => "取消" } }, review), "No");
	await assert.rejects(() => showReview({ ...rpc, ui: { ...rpc.ui, select: async () => undefined } }, review), /关闭或超时/);
	const noApprove = async () => { throw new Error("不完整预览不得进入确认"); };
	await assert.rejects(() => showReview({ ...rpc, ui: { editor: async (_t, p) => p.slice(0, 30000), select: noApprove } }, review), /修改或截断/);
	await assert.rejects(() => showReview({ ...rpc, ui: { editor: async () => undefined, select: noApprove } }, review), /预览已关闭/);
	await assert.rejects(() => showReview({ ...rpc, ui: { select: noApprove } }, review), /不支持安全审核/);
	const abortView = new AbortController();
	const waiting = showReview({ ...rpc, signal: abortView.signal, ui: { select: noApprove, editor: () => new Promise(() => {}) } }, review);
	abortView.abort(); assert.equal(await waiting, "No", "RPC editor 未响应时中断也能退出");
	await assert.rejects(() => showReview({ hasUI: true, mode: "tui", ui: {} }, review), /不支持安全审核/);
	await assert.rejects(() => showReview({ hasUI: true, mode: "tui", ui: { custom: async () => undefined } }, review), /未提供审核结果/);
	console.log("✓ RPC 一次完整滚动预览、Yes/No/Edit 顺序、默认选中 Yes、重看与取消降级");

	// 指纹测试只修改隔离副本，不动开发代码或真实安装。
	const source = path.join(process.env.TEST_AGENT_DIR, "runtime-copy");
	fs.mkdirSync(source, { recursive: true });
	for (const file of ["package.json", "index.ts", "curator.ts", "repo.ts", "baseline.ts", "host-role.ts", "review-ui.ts", "diagnostics.ts", "metadata.ts", "async.ts", "sync.ts", "snapshot.ts"]) {
		fs.copyFileSync(path.join(__dirname, "..", file), path.join(source, file));
	}
	const runtime = captureRuntime(source);
	assert(runtime.status().includes("与磁盘一致"));
	fs.appendFileSync(path.join(source, "curator.ts"), "\n// fixture: changed after load\n");
	assert(runtime.status().includes("本进程尚未加载"));
	assert(runtime.status().includes(runtime.fingerprint));
	assert.notEqual(captureRuntime(source).fingerprint, runtime.fingerprint);
	console.log("✓ 运行指纹固定，磁盘更新后准确提示 /reload");
})().catch((error) => { console.error(error); process.exitCode = 1; });
