/* Use the tested Pi's real argument preparation and validation on both API layouts. */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

exports.createToolPipeline = (sdk) => {
	const sdkRequire = createRequire(path.join(sdk, "package.json"));
	const coreRoot = path.dirname(sdkRequire.resolve("@earendil-works/pi-agent-core/package.json"));
	const legacyPath = path.join(coreRoot, "dist/harness/execution/tools.js");
	const executionPath = fs.existsSync(legacyPath) ? legacyPath : path.join(coreRoot, "dist/agent-loop.js");
	const pipeline = Promise.all([
		import(pathToFileURL(executionPath).href),
		import(pathToFileURL(path.join(sdk, "dist/core/tools/tool-definition-wrapper.js")).href),
	]);
	return async (definition, args, ctx, signal) => {
		const [execution, { wrapToolDefinition }] = await pipeline;
		const tool = wrapToolDefinition(definition, () => ctx);
		const call = { id: "test", name: tool.name, arguments: args };
		if (execution.prepareToolCall) {
			const prepared = execution.prepareToolCall(call, [tool]);
			if (prepared.kind === "immediate") throw new Error(prepared.result.content[0].text);
			return prepared.tool.execute(call.id, prepared.args, signal, undefined, ctx);
		}
		// Pi 1.0 exposes the complete prepare/validate/execute chain instead of preparation alone.
		const completed = await execution.runToolCall(call, { context: { messages: [], tools: [tool] }, signal });
		if (completed.isError) throw new Error(completed.result.content[0].text);
		return completed.result;
	};
};
