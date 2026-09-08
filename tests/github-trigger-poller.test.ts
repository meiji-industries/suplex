import { expect, test, vi } from "vitest";
import { GithubTriggerPoller } from "../src/github-trigger-poller.js";

test("runs once at startup and once sixty seconds after completion", async () => {
  vi.useFakeTimers(); let calls = 0; let release!: () => void;
  const poller = new GithubTriggerPoller(async () => { calls += 1; await new Promise<void>(resolve => { release = resolve; }); });
  poller.start(); poller.start(); expect(calls).toBe(1); await vi.advanceTimersByTimeAsync(60_000); expect(calls).toBe(1);
  release(); await vi.runAllTicks(); await vi.advanceTimersByTimeAsync(60_000); expect(calls).toBe(2); release(); await poller.stop(); vi.useRealTimers();
});

test("stops scheduling after an in-flight pass and reports errors", async () => {
  vi.useFakeTimers(); const errors: unknown[] = []; let calls = 0; let release!: () => void;
  const poller = new GithubTriggerPoller(async () => { calls += 1; if (calls === 1) throw new Error("offline"); await new Promise<void>(resolve => { release = resolve; }); }, error => errors.push(error));
  poller.start(); await vi.runAllTicks(); expect(errors).toHaveLength(1); await vi.advanceTimersByTimeAsync(60_000); expect(calls).toBe(2);
  const stopped = poller.stop(); release(); await stopped; await vi.advanceTimersByTimeAsync(60_000); expect(calls).toBe(2); vi.useRealTimers();
});
