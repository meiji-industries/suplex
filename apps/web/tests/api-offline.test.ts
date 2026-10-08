// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { toast } from "sonner";
import { readJson } from "../lib/api.js";

afterEach(() => vi.restoreAllMocks());

test("readJson replaces the browser fetch failure with an Offline notification that clears on the next response", async () => {
  const error = vi.spyOn(toast, "error");
  const success = vi.spyOn(toast, "success");
  const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("Failed to fetch"));

  await expect(readJson("/api/tasks")).rejects.toThrow("Suplex cannot reach the host.");
  expect(error).toHaveBeenCalledWith("Offline", expect.objectContaining({ duration: Infinity }));

  fetchMock.mockImplementation(async () => new Response("{}"));
  await readJson("/api/tasks");
  await readJson("/api/tasks");
  expect(success).toHaveBeenCalledTimes(1);
});

test("readJson keeps an aborted request as an abort", async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
  await expect(readJson("/api/tasks")).rejects.toThrow("Aborted");
});
