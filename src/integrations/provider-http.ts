export class ProviderHttpFailure extends Error {
  constructor(readonly status: number) { super(`The provider request failed (${status})`); }
}

/** Follow only same-origin API pagination; never forward credentials to response-supplied hosts. */
export async function providerBytes(url: URL, origin: string, authorization: string, input: RequestInit = {}, request: typeof fetch = fetch, maximumBytes = 8 * 1024 * 1024): Promise<Buffer> {
  if (url.origin !== origin || url.username || url.password) throw new Error("The provider returned an unsafe URL");
  const response = await request(url, { ...input, redirect: "error", signal: AbortSignal.timeout(30_000), headers: { Accept: "application/json", Authorization: authorization, ...(input.body && !(input.body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...input.headers } });
  return boundedProviderResponse(response, maximumBytes);
}

export async function boundedProviderResponse(response: Response, maximumBytes = 8 * 1024 * 1024): Promise<Buffer> {
  if (!response.ok) throw new ProviderHttpFailure(response.status);
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (Number(response.headers.get("content-length")) > maximumBytes) { await response.body?.cancel(); throw new Error("The provider response is too large"); }
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maximumBytes) { await reader.cancel(); throw new Error("The provider response is too large"); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
  }
  return Buffer.concat(chunks, size);
}

export async function providerJson(url: URL, origin: string, authorization: string, input: RequestInit = {}, request: typeof fetch = fetch): Promise<unknown> {
  const bytes = await providerBytes(url, origin, authorization, input, request);
  return bytes.byteLength ? JSON.parse(bytes.toString("utf8")) : null;
}
