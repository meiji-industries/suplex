// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from "vitest";
import { readJson } from "../src/frontend/lib/api.js";

const fetchMock = vi.fn<typeof fetch>();
afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset(); });

test("an unavailable client ID cannot block an ordinary API mutation", async () => {
  vi.stubGlobal("crypto", { randomUUID() { throw new Error("unavailable"); } });
  vi.stubGlobal("sessionStorage", { getItem() { throw new Error("unavailable"); } });
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(readJson<{ ok: boolean }>("/api/tasks/task-1/start", { method: "POST", body: "{}" })).resolves.toEqual({ ok: true });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const init = fetchMock.mock.calls[0]?.[1];
  expect(init?.headers).not.toHaveProperty("X-Suplex-Tab-Id");
});
