/* Load the actual extension through Pi, without aliases or a model request. */
process.env.MEMARK_REPO = process.env.TEST_REPO;
process.env.PI_CODING_AGENT_DIR = process.env.TEST_AGENT_DIR;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const sdk = process.env.MEMARK_TEST_PI_ROOT || path.resolve(process.env.PI_NODE_MODULES, "..");

(async () => {
	const { loadExtensions } = await import(pathToFileURL(path.join(sdk, "dist/core/extensions/loader.js")).href);
	const result = await loadExtensions([path.join(__dirname, "../index.ts")], process.env.TEST_REPO);
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, 1);
	const extension = result.extensions[0];
	assert.deepEqual([...extension.tools.keys()], ["memark_recall", "memark_remember"]);
	assert(extension.commands.has("memory"));
	console.log("OK: Pi 1.5 native loader registers both tools and /memory without module stubs");

	let inputs = 0;
	const ctx = { hasUI: true, mode: "rpc", ui: {
		input: async () => { inputs++; return undefined; },
		notify() {},
	} };
	const base = { type: "before_agent_start", systemPrompt: "BASE", systemPromptOptions: {} };
	const custom = { ...base, messageType: "custom", message: { customType: "test", content: "automated task", display: false } };
	const user = { ...base, messageType: "user", prompt: "user input" };
	const handlers = extension.handlers.get("before_agent_start");
	assert.equal(handlers.length, 1);
	const hook = handlers[0];
	const automated = await hook(custom, ctx);
	assert.equal(inputs, 0);
	assert(automated.systemPrompt.startsWith("BASE\n\n"));
	assert(automated.systemPrompt.length > "BASE\n\n".length);
	const interactive = await hook(user, ctx);
	assert.equal(inputs, 1, "a custom run must not consume the first user prompt");
	assert.equal(interactive.systemPrompt, automated.systemPrompt);
	await hook(custom, ctx);
	await hook(user, ctx);
	assert.equal(inputs, 1, "cancelled role input is not repeated in the same runtime");
	assert(!fs.existsSync(path.join(process.env.TEST_AGENT_DIR, "memark/host-role.json")));
	console.log("OK: native custom runs inject context without a dialog; the first user run can still prompt");
	// Do not emit session_start: this smoke test must not start background sync.
})().catch((error) => { console.error(error); process.exitCode = 1; });
