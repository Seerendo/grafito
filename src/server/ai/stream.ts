/** Run a producer as NDJSON, aborting it on disconnect or reader cancellation. */
export function ndjsonResponse<Event>(
  request: Request,
  produce: (emit: (event: Event) => void, signal: AbortSignal) => Promise<void>,
  onError: (error: unknown) => Event,
): Response {
  const abort = new AbortController();
  const encoder = new TextEncoder();
  let closed = false;
  const disconnect = () => abort.abort(request.signal.reason);
  const cleanup = () => request.signal.removeEventListener("abort", disconnect);
  if (request.signal.aborted) disconnect();
  else request.signal.addEventListener("abort", disconnect, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: Event) => {
        if (!closed && !abort.signal.aborted) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
      };
      try {
        abort.signal.throwIfAborted();
        await produce(emit, abort.signal);
      } catch (error) {
        if (!abort.signal.aborted) emit(onError(error));
      } finally {
        cleanup();
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
    cancel(reason) {
      closed = true;
      abort.abort(reason);
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
