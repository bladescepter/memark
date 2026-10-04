/** 记录模块加载时的代码指纹，不能把后来读到的磁盘版本冒充运行版本。 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_FILES = ["package.json", "index.ts", "curator.ts", "repo.ts", "baseline.ts", "host-role.ts", "review-ui.ts", "diagnostics.ts", "metadata.ts", "async.ts"];
export function captureRuntime(root: string) {
	const readBuild = () => {
		const version = String(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
		const hash = createHash("sha256");
		for (const file of SOURCE_FILES) hash.update(file).update("\0").update(readFileSync(join(root, file))).update("\0");
		return { version, fingerprint: hash.digest("hex").slice(0, 12) };
	};
	const loaded = readBuild();
	return {
		...loaded,
		root,
		label: `memark ${loaded.version}@${loaded.fingerprint}`,
		status() {
			const prefix = `运行版本：${loaded.version}@${loaded.fingerprint}\n加载路径：${root}`;
			try {
				const disk = readBuild();
				return `${prefix}\n磁盘版本：${disk.version}@${disk.fingerprint}\n` +
					(disk.fingerprint === loaded.fingerprint ? "已加载代码与磁盘一致。" : "⚠ 磁盘代码已变化，本进程尚未加载；请在此运行实例执行 /reload。") +
					" /memory sync 仅同步记忆数据，不升级扩展。";
			} catch {
				return `${prefix}\n⚠ 无法核对磁盘代码，请检查扩展安装路径。`;
			}
		},
	};
}

export const runtime = captureRuntime(dirname(fileURLToPath(import.meta.url)));
