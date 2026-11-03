/* Run the tested Pi 1.5 tool wrapper, argument preparation, validation, and execution. */
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

exports.createToolPipeline = (sdk) => {
	const sdkRequire = createRequire(path.join(sdk, "package.json"));
	const coreRoot = path.dirname(sdkRequire.resolve("@earendil-works/pi-agent-core/package.json"));
	const pipeline = Promise.all([
		import(pathToFileURL(path.join(coreRoot, "dist/agent-loop.js")).href),
		import(pathToFileURL(path.join(sdk, "dist/core/tools/tool-definition-wrapper.js")).href),
	]);
	return async (definition, args, ctx, signal) => {
		const [{ runToolCall }, { wrapToolDefinition }] = await pipeline;
		const tool = wrapToolDefinition(definition, () => ctx);
		const call = { id: "test", name: tool.name, arguments: args };
		const completed = await runToolCall(call, { context: { messages: [], tools: [tool] }, signal });
		if (completed.isError) throw new Error(completed.result.content[0].text);
		return completed.result;
	};
};
