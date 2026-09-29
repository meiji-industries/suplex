// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { SessionHistory } from "../src/frontend/features/tasks/task-chat/session-history.js";

class FakeWebSocket {
  static readonly instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }

  emit(value: unknown): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

class FakeResizeObserver implements ResizeObserver {
  static readonly instances: FakeResizeObserver[] = [];
  readonly #callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
    FakeResizeObserver.instances.push(this);
  }

  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
  takeRecords(): ResizeObserverEntry[] { return []; }
  trigger(): void { this.#callback([], this); }
}

afterEach(() => {
  FakeWebSocket.instances.length = 0;
  FakeResizeObserver.instances.length = 0;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

test("live history shows recorded reasoning on demand before the answer", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<SessionHistory taskId="task" sessionId="session" />));
  await act(async () => {
    FakeWebSocket.instances[0]?.emit({ type: "snapshot", page: { messages: [{ id: "message", role: "assistant", createdAt: null, content: [
      { id: "reasoning", type: "reasoning", text: "Checked the native transcript." },
      { id: "answer", type: "text", text: "Done." },
    ] }], olderCursor: null }, order: ["message"] });
    await Promise.resolve();
  });
  const trigger = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("Reasoning"));
  expect(trigger).toBeDefined();
  expect(container.textContent).toContain("Done.");
  expect(container.textContent).not.toContain("Checked the native transcript.");
  await act(async () => trigger?.click());
  expect(container.textContent).toContain("Checked the native transcript.");
  await act(async () => {
    FakeWebSocket.instances[0]?.emit({ type: "update", messages: [{ id: "message", role: "assistant", createdAt: null, content: [
      { id: "reasoning", type: "reasoning", text: "Checked the native transcript and tests." },
      { id: "answer", type: "text", text: "Done." },
    ] }], removedIds: [], order: ["message"] });
    await Promise.resolve();
  });
  expect(container.textContent).toContain("Checked the native transcript and tests.");
  await act(async () => root.unmount());
});

test("a resize keeps a following viewport at the latest message without moving a paused reader", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<SessionHistory taskId="task" sessionId="session" />));
  const viewport = container.querySelector<HTMLElement>("[data-session-history]");
  const observer = FakeResizeObserver.instances[0];
  expect(viewport).not.toBeNull();
  expect(observer).toBeDefined();
  if (!viewport || !observer) return;
  let scrollHeight = 1_000;
  let clientHeight = 300;
  Object.defineProperty(viewport, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(viewport, "clientHeight", { configurable: true, get: () => clientHeight });
  await act(async () => {
    FakeWebSocket.instances[0]?.emit({ type: "snapshot", page: { messages: [{ id: "message", role: "assistant", createdAt: null, content: [{ id: "text", type: "text", text: "Latest output" }] }], olderCursor: null }, order: ["message"] });
    await Promise.resolve();
  });

  viewport.scrollTop = 400;
  viewport.dispatchEvent(new Event("scroll"));
  observer.trigger();
  frames.splice(0).forEach(callback => callback(0));
  expect(viewport.scrollTop).toBe(400);

  viewport.scrollTop = 700;
  viewport.dispatchEvent(new Event("scroll"));
  scrollHeight = 1_140;
  clientHeight = 100;
  viewport.dispatchEvent(new Event("scroll"));
  observer.trigger();
  frames.splice(0).forEach(callback => callback(0));
  expect(viewport.scrollTop).toBe(1_140);
  await act(async () => root.unmount());
});

test("a session switch ignores events from the previous live socket", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<SessionHistory taskId="task" sessionId="first" />));
  const first = FakeWebSocket.instances[0];
  expect(first?.url).toContain("/sessions/first/history/live");
  await act(async () => {
    first?.emit({ type: "snapshot", page: { messages: [{ id: "first-message", role: "assistant", createdAt: null, content: [{ id: "first-text", type: "text", text: "First output" }] }], olderCursor: null }, order: ["first-message"] });
    await Promise.resolve();
  });
  expect(container.textContent).toContain("First output");

  await act(async () => root.render(<SessionHistory taskId="task" sessionId="second" />));
  const second = FakeWebSocket.instances[1];
  expect(first?.readyState).toBe(FakeWebSocket.CLOSED);
  expect(second?.url).toContain("/sessions/second/history/live");
  await act(async () => {
    first?.emit({ type: "update", messages: [{ id: "stale", role: "assistant", createdAt: null, content: [{ id: "stale-text", type: "text", text: "Stale output" }] }], removedIds: [], order: ["first-message", "stale"] });
    second?.emit({ type: "snapshot", page: { messages: [{ id: "second-message", role: "assistant", createdAt: null, content: [{ id: "second-text", type: "text", text: "Second output" }] }], olderCursor: null }, order: ["second-message"] });
    await Promise.resolve();
  });

  expect(container.textContent).toContain("Second output");
  expect(container.textContent).not.toContain("Stale output");
  await act(async () => root.unmount());
  expect(second?.readyState).toBe(FakeWebSocket.CLOSED);
});
