import { expect, test } from "vitest";
import type { NativeHistoryMessage } from "../src/tasks/history/contracts.js";
import { pageSessionHistory, SessionHistoryCursorError } from "../src/tasks/history/history.js";
import { anchoredScrollTop, historyAtBottom, mergeNativeHistory, readLatestHistory, sessionHistoryLabels } from "../src/frontend/features/tasks/task-chat/session-history-state.js";

const message = (id: string, text = id): NativeHistoryMessage => ({ id, role: "assistant", createdAt: null, content: [{ id: `${id}-text`, type: "text", text }] });

test("history pages newest-first by cursor while each page remains in native order", () => {
  const messages = Array.from({ length: 95 }, (_, index) => message(`message-${index}`));
  const newest = pageSessionHistory(messages);
  expect(newest.messages.map(item => item.id)).toEqual(messages.slice(55).map(item => item.id));
  expect(newest.olderCursor).toBe("message-55");
  const earlier = pageSessionHistory(messages, newest.olderCursor!);
  expect(earlier.messages.map(item => item.id)).toEqual(messages.slice(15, 55).map(item => item.id));
  expect(earlier.olderCursor).toBe("message-15");
  expect(() => pageSessionHistory(messages, "missing")).toThrow(SessionHistoryCursorError);
  expect(pageSessionHistory([message("one"), message("two", "partial"), message("two", "complete")]).messages).toEqual([message("one"), message("two", "complete")]);
});

test("polling replaces evolving messages without dropping loaded history", () => {
  const loaded = [message("old"), message("live", "partial")];
  const merged = mergeNativeHistory(loaded, [message("live", "complete"), message("new")], "latest");
  expect(merged.map(item => [item.id, item.content[0]])).toEqual([
    ["old", expect.objectContaining({ text: "old" })],
    ["live", expect.objectContaining({ text: "complete" })],
    ["new", expect.objectContaining({ text: "new" })],
  ]);
  expect(mergeNativeHistory(merged, [message("earlier"), message("old")], "earlier").map(item => item.id)).toEqual(["earlier", "old", "live", "new"]);
});

test("the authoritative page order places a newly visible streaming message correctly", () => {
  const current = [message("old"), message("latest")];
  expect(mergeNativeHistory(current, [message("streamed"), message("latest")], "latest").map(item => item.id)).toEqual(["old", "streamed", "latest"]);
});

test("latest history bridges every page back to the loaded messages", async () => {
  const current = Array.from({ length: 40 }, (_, index) => message(String(index)));
  const cursors: Array<string | undefined> = [];
  const result = await readLatestHistory(current, async before => {
    cursors.push(before);
    if (before === undefined) return { messages: Array.from({ length: 40 }, (_, index) => message(String(index + 60))), olderCursor: "60" };
    if (before === "60") return { messages: Array.from({ length: 40 }, (_, index) => message(String(index + 20))), olderCursor: "20" };
    throw new Error(`Unexpected cursor ${before}`);
  });
  expect(cursors).toEqual([undefined, "60"]);
  expect(result.messages.map(item => item.id)).toEqual(Array.from({ length: 100 }, (_, index) => String(index)));
  expect(new Set(result.messages.map(item => item.id))).toHaveProperty("size", 100);
});

test("latest history exposes pagination after an initially empty response", async () => {
  expect(await readLatestHistory([], async () => ({ messages: [], olderCursor: null }))).toEqual({ messages: [], olderCursor: null });
  const populated = await readLatestHistory([], async () => ({ messages: [message("latest")], olderCursor: "earlier" }));
  expect(populated).toEqual({ messages: [message("latest")], olderCursor: "earlier" });
});

test("scroll helpers pause follow and preserve the earlier-message anchor", () => {
  expect(historyAtBottom({ scrollHeight: 1_000, scrollTop: 680, clientHeight: 300 })).toBe(true);
  expect(historyAtBottom({ scrollHeight: 1_000, scrollTop: 500, clientHeight: 300 })).toBe(false);
  expect(anchoredScrollTop({ scrollHeight: 1_000, scrollTop: 420 }, 1_600)).toBe(1_020);
});

test("replacement sessions use distinct names instead of turn generations", () => {
  expect([...sessionHistoryLabels([{ id: "root", label: "Coordinator" }, { id: "worker-old", label: "Worker" }, { id: "worker-new", label: "Worker" }, { id: "reviewer", label: "Reviewer" }])]).toEqual([
    ["root", "Coordinator"], ["worker-old", "Worker 1"], ["worker-new", "Worker 2"], ["reviewer", "Reviewer"],
  ]);
});
