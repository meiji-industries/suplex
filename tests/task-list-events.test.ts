import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTaskListInvalidationHub, readTaskList } from "../src/frontend/lib/task-list.js";

type FakeListener = (event: { data?: string }) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static reset(): void { FakeEventSource.instances = []; }
  static get last(): FakeEventSource { return FakeEventSource.instances[FakeEventSource.instances.length - 1]!; }

  closed = false;
  connected = true;
  private readonly listeners = new Map<string, FakeListener[]>();

  constructor(readonly url: string) { FakeEventSource.instances.push(this); }

  addEventListener(type: string, listener: FakeListener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  close(): void { this.closed = true; }

  disconnect(): void { this.connected = false; }

  invalidate(companyId: string): void {
    const event = { data: JSON.stringify({ companyId }) };
    for (const listener of this.listeners.get("invalidate") ?? []) listener(event);
  }

  ready(): void {
    this.connected = true;
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

    vi.advanceTimersByTime(2999);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("invalidate");

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
    vi.advanceTimersByTime(3000);
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("refetches every subscribed company when ready fires after reconnect", async () => {
    let version = "baseline";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const companyId = decodeURIComponent(new URL(String(input), "http://forge.test").pathname.split("/")[3] ?? "");
      return new Response(JSON.stringify({ tasks: [{ id: `${companyId}-${version}` }] }));
    }));
    const hub = createHub();
    const refreshes: Array<Promise<unknown>> = [];
    const firstUnsubscribe = hub.subscribe("company-reconnect-a", () => { refreshes.push(readTaskList("company-reconnect-a")); });
    const secondUnsubscribe = hub.subscribe("company-reconnect-b", () => { refreshes.push(readTaskList("company-reconnect-b")); });

    await expect(Promise.all([readTaskList("company-reconnect-a"), readTaskList("company-reconnect-b")])).resolves.toEqual([
      [{ id: "company-reconnect-a-baseline" }],
      [{ id: "company-reconnect-b-baseline" }],
    ]);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);

    FakeEventSource.last.disconnect();
    expect(FakeEventSource.last.connected).toBe(false);
    version = "mutated";
    FakeEventSource.last.ready();
    await vi.advanceTimersByTimeAsync(3000);

    await expect(Promise.all(refreshes)).resolves.toEqual([
      [{ id: "company-reconnect-a-mutated" }],
      [{ id: "company-reconnect-b-mutated" }],
    ]);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(4);
    expect(FakeEventSource.last.connected).toBe(true);

    firstUnsubscribe();
    secondUnsubscribe();
  });

  it("reports ready when reconnect and invalidation events are coalesced", () => {
    const hub = createHub();
    const listener = vi.fn();
    const unsubscribe = hub.subscribe("company-a", listener);

    FakeEventSource.last.invalidate("company-a");
    FakeEventSource.last.ready();
    vi.advanceTimersByTime(3000);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith("ready");
    unsubscribe();
  });

  it("reuses one resolved read for three listeners after an invalidation", async () => {
    const hub = createHub();
    const refreshes: Array<Promise<unknown>> = [];
    const unsubscribes = Array.from({ length: 3 }, () => hub.subscribe("company-a", () => { refreshes.push(readTaskList("company-a")); }));
    await readTaskList("company-a", false, true);
    FakeEventSource.last.invalidate("company-a");
    await vi.advanceTimersByTimeAsync(3000);

    await expect(Promise.all(refreshes)).resolves.toEqual([[], [], []]);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
    unsubscribes.forEach((unsubscribe) => unsubscribe());
  });

  it("expires a resolved task-list read after two seconds", async () => {
    await readTaskList("company-ttl", false, true);
    await readTaskList("company-ttl");
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2000);
    await readTaskList("company-ttl");
    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
  });
});
