exports.withFileMutationQueue = async (_path, fn) => fn();
exports.getAgentDir = () => process.env.TEST_AGENT_DIR;
