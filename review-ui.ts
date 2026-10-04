/** 长预览与批准操作分离；TUI 固定操作区，RPC 完整分页，未知 UI 安全停止。 */
import type { ExtensionContext, ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, ScrollView, Text, truncateToWidth, wrapTextWithAnsi, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";

export interface ReviewContext {
	hasUI?: boolean;
	mode?: ExtensionContext["mode"];
	signal?: AbortSignal;
	ui: Pick<ExtensionUIContext, "notify" | "confirm"> & Partial<Pick<ExtensionUIContext, "custom" | "select" | "editor" | "input">>;
}
export type ReviewChoice = "Yes" | "No" | "Edit";
export interface Review {
	title: string;
	summary: string;
	text: string;
	canEdit: boolean;
}

/** 控制字符必须可见，不能让记忆文本向终端注入控制序列。 */
export function displayText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).replace(/\t/g, "    ");
}

/** 使用 Pi 的 Text 换行和 ScrollView 管理滚动；只对内容区裁切，不裁切操作区。 */
export class ReviewPanel implements Component {
	private readonly body: Text;
	private readonly scroll: ScrollView;
	private readonly options: ReviewChoice[];
	private selected = 1; // 默认 No，避免盲按 Enter 即批准。
	private usable = false;
	private closed = false;
	private actionRow = 0;
	private readonly abort = () => this.finish("No");

	constructor(
		private readonly review: Review,
		private readonly tui: Pick<TUI, "terminal" | "requestRender">,
		private readonly theme: Pick<Theme, "fg" | "bold">,
		private readonly kb: Pick<KeybindingsManager, "matches">,
		private readonly done: (choice: ReviewChoice) => void,
		private readonly signal?: AbortSignal,
	) {
		this.body = new Text(displayText(`${review.summary}\n\n${review.text}`), 0, 0);
		this.scroll = new ScrollView(this.body, { follow: "none", scrollbar: "hidden", overscroll: "contain" });
		this.options = review.canEdit ? ["Yes", "No", "Edit"] : ["Yes", "No"];
		signal?.addEventListener("abort", this.abort, { once: true });
		if (signal?.aborted) queueMicrotask(this.abort);
	}

	private finish(choice: ReviewChoice): void {
		if (this.closed) return;
		this.closed = true;
		this.dispose();
		this.done(choice);
	}

	render(width: number): string[] {
		const height = Math.max(1, this.tui.terminal.rows - 4);
		this.usable = width >= 24 && height >= 10;
		if (!this.usable) {
			return [truncateToWidth("窗口过小，请放大；Esc 取消", width)];
		}
		const clip = (line: string) => truncateToWidth(line, width);
		const content = this.scroll.render(width);
		const bodyHeight = height - this.options.length - 5;
		this.scroll.updateLayout(content.length, bodyHeight, () => this.tui.requestRender());
		const top = this.scroll.scrollTop;
		const visible = content.slice(top, top + bodyHeight);
		while (visible.length < bodyHeight) visible.push("");
		this.actionRow = 2 + bodyHeight + 1;
		return [
			clip(this.theme.fg("accent", this.theme.bold(displayText(this.review.title).replace(/\n/g, " ")))),
			clip(displayText(this.review.summary).replace(/\n/g, " · ")),
			...visible.map(clip),
			clip(this.theme.fg("muted", `${top + 1}–${Math.min(top + bodyHeight, content.length)} / ${content.length} 行`)),
			...this.options.map((option, i) => clip(this.theme.fg(i === this.selected ? "accent" : "text", `${i === this.selected ? "→" : " "} ${i + 1} ${option}`))),
			clip("↑↓ 选择 · Enter 确认 · Esc 取消"),
			clip("PgUp/PgDn 滚动 · Home/End 首尾"),
		];
	}

	handleInput(data: string): void {
		if (this.kb.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c")) return this.finish("No");
		if (!this.usable || this.signal?.aborted || this.closed) return;
		if (matchesKey(data, "pageUp")) this.scroll.scrollBy(-Math.max(1, this.scroll.viewportHeight - 1));
		else if (matchesKey(data, "pageDown")) this.scroll.scrollBy(Math.max(1, this.scroll.viewportHeight - 1));
		else if (matchesKey(data, "home")) this.scroll.scrollToStart();
		else if (matchesKey(data, "end")) this.scroll.scrollToEnd();
		else if (this.kb.matches(data, "tui.select.up") || data === "k") this.selected = Math.max(0, this.selected - 1);
		else if (this.kb.matches(data, "tui.select.down") || data === "j") this.selected = Math.min(this.options.length - 1, this.selected + 1);
		else if (/^[123]$/.test(data)) this.selected = Math.min(this.options.length - 1, Number(data) - 1);
		else if (this.kb.matches(data, "tui.select.confirm")) return this.finish(this.options[this.selected]);
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent) {
		if (!this.usable || this.closed) return undefined;
		if (event.type === "wheel") {
			this.scroll.scrollBy(event.wheelDelta ?? 0);
			this.tui.requestRender();
			return { handled: true };
		}
		if (event.type === "click" && event.button === "left") {
			const index = event.y - this.actionRow;
			if (index >= 0 && index < this.options.length) {
				this.finish(this.options[index]);
				return { handled: true };
			}
		}
		return undefined;
	}

	invalidate(): void { this.body.invalidate(); }
	dispose(): void { this.signal?.removeEventListener("abort", this.abort); }
}

export class ReviewUnavailable extends Error {}

export async function showReview(ctx: ReviewContext, review: Review): Promise<ReviewChoice> {
	if (ctx.signal?.aborted) return "No";
	if (!ctx.hasUI) throw new ReviewUnavailable("没有可用的审核界面");
	if (ctx.mode === "tui" && ctx.ui.custom) {
		try {
			const choice = await ctx.ui.custom<ReviewChoice>((tui, theme, kb, done) =>
				new ReviewPanel(review, tui, theme, kb, done, ctx.signal), {
				overlay: true,
				overlayOptions: { width: "100%", maxHeight: "100%", margin: 1 },
			});
			if (ctx.signal?.aborted) return "No";
			if (choice !== "Yes" && choice !== "No" && choice !== "Edit") throw new ReviewUnavailable("客户端未提供审核结果");
			return choice === "Edit" && !review.canEdit ? "No" : choice;
		} catch (err) {
			throw new ReviewUnavailable(`终端审核界面失败：${(err as Error).message}`);
		}
	}
	// RPC 没有终端行数，也不支持 custom。使用有界短页，不能把全部 diff 塞入标题。
	if (ctx.mode !== "rpc" || !ctx.ui.select) throw new ReviewUnavailable("当前客户端不支持安全审核，请使用 TUI 或支持 select 的 RPC 客户端");
	const lines = wrapTextWithAnsi(displayText(`${review.summary}\n\n${review.text}`), 48);
	const pageSize = 6;
	const pages = Math.max(1, Math.ceil(lines.length / pageSize));
	const opts = { signal: ctx.signal, timeout: 300_000 };
	try {
		for (let page = 0; page < pages;) {
			if (ctx.signal?.aborted) return "No";
			const next = page === pages - 1 ? "审核" : "下一页";
			const choice = await ctx.ui.select(`memark：预览 ${page + 1}/${pages}\n${lines.slice(page * pageSize, (page + 1) * pageSize).join("\n")}`,
				page > 0 ? [next, "上一页", "取消"] : [next, "取消"], opts);
			if (ctx.signal?.aborted) return "No";
			if (choice === undefined) throw new ReviewUnavailable("RPC 审核已关闭或超时，候选保留待重新审核");
			if (choice === "上一页" && page > 0) page--;
			else if (choice === next) page++;
			else return "No"; // 取消、超时或客户端的异常返回都不能批准。
		}
		if (ctx.signal?.aborted) return "No";
		const choice = await ctx.ui.select("memark：已展示全部变更，是否写入？", review.canEdit ? ["Yes", "No", "Edit"] : ["Yes", "No"], opts);
		if (ctx.signal?.aborted) return "No";
		if (choice === undefined) throw new ReviewUnavailable("RPC 审核已关闭或超时，候选保留待重新审核");
		return choice === "Yes" || (choice === "Edit" && review.canEdit) ? choice : "No";
	} catch (err) {
		throw new ReviewUnavailable(`RPC 审核界面失败：${(err as Error).message}`);
	}
}
