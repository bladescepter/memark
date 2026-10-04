/** 等待可取消操作；取消仅结束等待，底层操作仍须自行使用同一 signal。 */
export function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason ?? new Error("操作已取消"));
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		// 即使已取消也消费底层结果，避免迟到的 rejection 未处理。
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
