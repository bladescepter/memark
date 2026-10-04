/** memory 的单行 frontmatter 读取契约；不是通用 YAML。坏字段一律拒绝，不信任索引代替正文。 */
export type MetadataValue = string | boolean | null | string[];
export type Metadata = Record<string, MetadataValue>;

export function splitFrontmatter(text: string): { header: string; body: string } | null {
	const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
	return match ? { header: match[1], body: match[2] } : null;
}

/** 更新指定字段，其他治理字段保留原始写法（包括 null、引号和日期）。 */
export function rewriteMemory(text: string, updates: Record<string, string | null>, body?: string): string {
	const front = splitFrontmatter(text);
	if (!front || !parseMetadata(text)) throw new Error("缺少合法 frontmatter");
	const lines = front.header.split(/\r?\n/).filter((line) => !Object.hasOwn(updates, line.split(":", 1)[0].trim()));
	for (const [key, value] of Object.entries(updates)) if (value !== null) lines.push(`${key}: ${value}`);
	return `---\n${lines.join("\n")}\n---\n${body ?? front.body}`;
}

function quotedString(raw: string): string {
	const quote = raw[0];
	if (raw.length < 2 || raw.at(-1) !== quote) throw new Error("引号未闭合");
	let out = "";
	const escapes: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
	for (let i = 1; i < raw.length - 1; i++) {
		const ch = raw[i];
		if (ch === quote) throw new Error("字符串中有未转义引号");
		if (ch !== "\\") { out += ch; continue; }
		const next = raw[++i];
		if (i >= raw.length - 1) throw new Error("不完整的转义");
		if (next === "\\" || next === "'" || next === '"') out += next;
		else if (next in escapes) out += escapes[next];
		else if (next === "x" || next === "u" || next === "U") {
			const length = next === "x" ? 2 : next === "u" ? 4 : 8;
			const hex = raw.slice(i + 1, i + 1 + length);
			if (hex.length !== length || !/^[\da-f]+$/i.test(hex)) throw new Error("非法字符转义");
			out += String.fromCodePoint(Number.parseInt(hex, 16));
			i += length;
		} else if (/[0-7]/.test(next)) {
			const octal = raw.slice(i).match(/^[0-7]{1,3}/)![0];
			out += String.fromCodePoint(Number.parseInt(octal, 8));
			i += octal.length - 1;
		} else if (next === "N") throw new Error("不支持 Unicode 名称转义，请直接使用文字");
		else out += `\\${next}`; // 与协议脚本的 Python 字符串未知转义保持一致。
	}
	return out;
}

function scalar(raw: string): MetadataValue {
	const value = raw.trim();
	if (!value) throw new Error("字段为空");
	if (value === "null" || value === "~") return null;
	if (value === "true" || value === "false") return value === "true";
	if (value[0] === '"' || value[0] === "'") return quotedString(value);
	if (value.startsWith("[")) {
		if (!value.endsWith("]")) throw new Error("非法标签列表");
		const inner = value.slice(1, -1).trim();
		if (!inner) return [];
		return inner.split(",").map((item) => {
			const tag = item.trim();
			if (!tag) throw new Error("空标签");
			return tag[0] === '"' || tag[0] === "'" ? quotedString(tag) : tag;
		});
	}
	return value;
}

export function parseMetadata(text: string): Metadata | null {
	const front = splitFrontmatter(text);
	if (!front) return null;
	const fields: Metadata = Object.create(null);
	try {
		for (const line of front.header.split(/\r?\n/)) {
			if (!line.trim() || line.trimStart().startsWith("#")) continue;
			const match = line.match(/^([a-z][a-z0-9_-]*)[ \t]*:[ \t]*(.*)$/);
			if (!match || Object.hasOwn(fields, match[1])) return null;
			fields[match[1]] = scalar(match[2]);
		}
		return fields;
	} catch { return null; }
}

/** 展示/路由使用的标量视图；null 不冒充字符串 "null"。 */
export function parseSimpleFrontmatter(text: string): Record<string, string> {
	const fields = parseMetadata(text);
	return Object.fromEntries(Object.entries(fields ?? {}).filter(([, value]) => value !== null)
		.map(([key, value]) => [key, Array.isArray(value) ? JSON.stringify(value) : String(value)]));
}

export function validDate(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

/** 路径与声明类型/范围须相符；兼容协议允许的层/项目根文件。 */
export function matchesMemoryPath(rel: string, fields: Metadata): boolean {
	const parts = rel.split("/");
	const types: Record<string, string[]> = {
		identity: ["Identity"], principles: ["Principle"], preferences: ["Preference"],
		context: ["Context"], knowledge: ["Skill", "Experience", "Learning"],
	};
	const categories: Record<string, string[]> = { context: ["current", "relationships"], knowledge: ["skills", "experiences", "learnings"] };
	if (Object.hasOwn(types, parts[0])) {
		return fields.scope !== "project" && types[parts[0]].includes(String(fields.type)) &&
			(parts.length === 2 || (parts.length === 3 && (categories[parts[0]] ?? []).includes(parts[1])));
	}
	const projectTypes: Record<string, string> = { Decision: "decisions", Topic: "topics", Incident: "incidents", Handoff: "handoffs" };
	return parts[0] === "projects" && fields.scope === "project" && Object.hasOwn(projectTypes, String(fields.type)) &&
		(parts.length === 3 || (parts.length === 4 && parts[2] === projectTypes[String(fields.type)]));
}

/** expires 当天仍有效；无值/null 为无到期日，非法日期不参与读取。 */
export function currentMemory(fields: Metadata, date = new Date().toISOString().slice(0, 10)): boolean {
	const expiry = fields.expires;
	return fields.status === "active" && fields.reviewed === true && validDate(fields.timestamp) &&
		[fields.title, fields.description].every((value) => typeof value === "string" && value.trim() && !/[\r\n]/.test(value)) &&
		Array.isArray(fields.tags) && fields.tags.length > 0 && fields.tags.every((tag) => tag.trim()) &&
		typeof fields.type === "string" && typeof fields.privacy === "string" && ["internal", "public"].includes(fields.privacy) &&
		(fields.scope === undefined || (typeof fields.scope === "string" && ["user", "project", "workflow", "context"].includes(fields.scope))) &&
		(fields.source === undefined || (typeof fields.source === "string" && ["user-explicit", "user-confirmed", "verified-file", "runtime-verified"].includes(fields.source))) &&
		(expiry == null || (validDate(expiry) && expiry >= date)) &&
		(fields.type !== "Handoff" || validDate(expiry));
}
