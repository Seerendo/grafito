/**
 * Read a JSON answer. A body that cannot be read is an error, not an empty success: a request
 * cancelled while its answer was being read used to come back as `{}` with a 2xx status, and the
 * caller went on without the data it needed (an upload part without its ETag).
 */
export async function readAnswer<T>(
  response: Response,
  signal?: AbortSignal | null,
): Promise<{ ok: true; body: T } | { ok: false; status: number; error: string }> {
  let body: (T & { error?: string }) | null = null;
  try {
    body = (await response.json()) as T & { error?: string };
  } catch (failure) {
    // Cancelled while reading: the caller sees the cancellation, as with the request itself.
    if (signal?.aborted) throw signal.reason ?? failure;
    if (response.ok) return { ok: false, status: response.status, error: "" };
  }
  if (!response.ok) return { ok: false, status: response.status, error: body?.error ?? "" };
  return { ok: true, body: body as T };
}
