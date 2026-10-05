// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { toast } from "sonner";

import { copyToClipboard } from "../src/frontend/lib/clipboard.js";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

test("shows the specific success toast only after the clipboard write succeeds", async () => {
  let complete!: () => void;
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
  const copying = copyToClipboard("feature/task-url", "Copied the branch to clipboard");
  expect(writeText).toHaveBeenCalledWith("feature/task-url");
  expect(toast.success).not.toHaveBeenCalled();
  complete();
  await expect(copying).resolves.toBe(true);
  expect(toast.success).toHaveBeenCalledExactlyOnceWith("Copied the branch to clipboard");
  expect(toast.error).not.toHaveBeenCalled();
});

test("shows an error toast and reports a failed clipboard write", async () => {
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Clipboard denied"));
  await expect(copyToClipboard("feature/task-url", "Copied the branch to clipboard")).resolves.toBe(false);
  expect(toast.error).toHaveBeenCalledExactlyOnceWith("Suplex could not copy to clipboard. Select the text and copy it.");
  expect(toast.success).not.toHaveBeenCalled();
});

test("shows an error toast when the clipboard API is not available", async () => {
  vi.stubGlobal("navigator", {});
  await expect(copyToClipboard("feature/task-url", "Copied the branch to clipboard")).resolves.toBe(false);
  expect(toast.error).toHaveBeenCalledOnce();
  expect(toast.success).not.toHaveBeenCalled();
});
