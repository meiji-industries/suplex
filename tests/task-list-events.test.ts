import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTaskListInvalidationHub, readTaskList } from "../src/frontend/lib/task-list.js";

type FakeListener = (event: { data?: string }) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static reset(): void { FakeEventSource.instances = []; }
  static get last(): FakeEventSource { return FakeEventSource.instances[FakeEventSource.instances.length - 1]!; }

  closed = false;
  private readonly listeners = new Map<string, FakeListener[]>();

  constructor(readonly url: string) { FakeEventSource.instances.push(this); }

  addEventListener(type: string, listener: FakeListener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  close(): void { this.closed = true; }

  invalidate(companyId: string): void {
    const event = { data: JSON.stringify({ companyId }) };
    for (const listener of this.listeners.get("invalidate") ?? []) listener(event);
  }

  ready(): void {
    const event = { data: JSON.stringify({ companyId: "company-a" }) };
    for (const listener of this.listeners.get("ready") ?? []) listener(event);
  }
}

describe("task list invalidation hub", () => {
  beforeEach(() => {
    FakeEventSource.reset();
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ tasks: [] }) })));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const createHub = () => createTaskListInvalidationHub({ createEventSource: (url) => new FakeEventSource(url) as unknown as EventSource });

  it("coalesces a burst of invalidations into one listener call and one cache clear", async () => {
    const hub = createHub();
    const listener = vi.fn();
    const unsubscribe = hub.subscribe("company-a", listener);
    const first = await readTaskList("company-a");
    expect(first).toEqual([]);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);

    for (let index = 0; index < 10; index += 1) FakeEventSource.last.invalidate("company-a");
    expect(listener).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(listener).toHaveBeenCalledTimes(1);

    const second = await readTaskList("company-a");
    expect(second).toEqual([]);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
    unsubscribe();
  });

  it("opens one EventSource for two subscribers and closes it after the last unsubscribe", () => {
    const hub = createHub();
    const first = hub.subscribe("company-a", () => {});
    const second = hub.subscribe("company-a", () => {});
    expect(FakeEventSource.instances).toHaveLength(1);

    first();
    expect(FakeEventSource.last.closed).toBe(false);
    second();
    expect(FakeEventSource.last.closed).toBe(true);
  });

  it("does not notify listeners for another company", () => {
    const hub = createHub();
    const listener = vi.fn();
    const unsubscribe = hub.subscribe("company-a", listener);

    FakeEventSource.last.invalidate("company-b");
    vi.advanceTimersByTime(300);
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("ignores ready events", () => {
    const hub = createHub();
    const listener = vi.fn();
    const unsubscribe = hub.subscribe("company-a", listener);

    FakeEventSource.last.ready();
    vi.advanceTimersByTime(300);
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
  });
});
