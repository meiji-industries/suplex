import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { ForgeDatabase } from "../src/database.js";
import { startHerdrEventSubscriber } from "../src/herdr-events.js";
import type { HerdrSocket } from "../src/herdr-socket.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((fn) => fn())); });

test("Herdr events project known panes and reconnect", async () => {
  vi.useFakeTimers();
  const root = await mkdtemp(join(tmpdir(), "forge-herdr-events-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  cleanup.push(async () => { database.close(); await rm(root, { recursive: true, force: true }); vi.useRealTimers(); });
  database.authQuery((db) => db.pragma("foreign_keys = OFF"));
  database.authQuery((db) => db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, agent_name, pane_id, status, created_at, updated_at) VALUES ('s', 't', 'planner', 1, 1, 'codex', 'a', 'known', 'starting', 'x', 'x')").run());
  let event: ((value: { event: string; data: Record<string, unknown> }) => void) | undefined;
  let calls = 0;
  const connect = async (): Promise<HerdrSocket> => ({ request: async <T,>(method: string) => (method === "session.snapshot" ? { panes: [{ pane_id: "known", agent_status: "idle" }] } : {}) as T, subscribe: async (_subscriptions, receive) => { event = receive; return () => undefined; }, close: () => undefined });
  const subscriber = startHerdrEventSubscriber(database, { connect: async () => { calls += 1; return connect(); } });
  await vi.advanceTimersByTimeAsync(0);
  expect(database.authQuery((db) => db.prepare("SELECT status FROM forge_herdr_role_sessions WHERE id='s'").get())).toEqual({ status: "ready" });
  event?.({ event: "pane.agent_status_changed", data: { pane_id: "known", agent_status: "working" } });
  expect(database.authQuery((db) => db.prepare("SELECT status, last_agent_status FROM forge_herdr_role_sessions WHERE id='s'").get())).toEqual({ status: "working", last_agent_status: "working" });
  event?.({ event: "pane.agent_status_changed", data: { pane_id: "unknown", agent_status: "blocked" } });
  event?.({ event: "pane.closed", data: { pane_id: "known" } });
  expect(database.authQuery((db) => db.prepare("SELECT status FROM forge_herdr_role_sessions WHERE id='s'").get())).toEqual({ status: "closed" });
  event?.({ event: "socket_closed", data: {} });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(calls).toBeGreaterThan(2);
  subscriber.stop();
});
