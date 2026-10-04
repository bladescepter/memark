// 仅替换配置目录，文件队列必须使用真实 Pi 实现，否则并发保护测试会假通过。
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const sdk = process.env.MEMARK_TEST_PI_ROOT || path.resolve(process.env.PI_NODE_MODULES, "..");
const queues = import(pathToFileURL(path.join(sdk, "dist/core/tools/file-mutation-queue.js")).href);
exports.withFileMutationQueue = (...args) => queues.then((mod) => mod.withFileMutationQueue(...args));
exports.getAgentDir = () => process.env.TEST_AGENT_DIR;
