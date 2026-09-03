import type { ForgeDatabase } from "./database.js";
import { connectHerdrSocket, type HerdrSocket } from "./herdr-socket.js";
import type { Logger } from "pino";

type Event = { event: string; data: Record<string, unknown> };
// Herdr requires a pane_id on every pane.* subscription, accepts exactly one events.subscribe per
// connection, and rejects the whole request when a pane id is unknown. So each run opens a fresh
// subscription for the pane ids Forge knows about that Herdr's snapshot confirms exist.
const eventTypes = ["pane.agent_status_changed", "pane.closed", "pane.exited", "pane.agent_detected"];
const iso = (): string => new Date().toISOString();

function string(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof data[key] === "string") return data[key] as string;
  return undefined;
}

function apply(database: ForgeDatabase, event: Event): void {
  const paneId = string(event.data, "pane_id", "paneId");
  if (!paneId) return;
  const timestamp = iso();
  if (event.event === "pane.agent_detected" || event.event === "pane_agent_detected") {
    database.authTransaction((db) => db.prepare("UPDATE forge_herdr_role_sessions SET last_seen_at = ?, updated_at = ? WHERE pane_id = ? AND is_current = 1").run(timestamp, timestamp, paneId));
    return;
  }
  if (["pane.closed", "pane.exited", "pane_closed", "pane_exited"].includes(event.event)) {
    database.authTransaction((db) => db.prepare("UPDATE forge_herdr_role_sessions SET status = 'closed', updated_at = ? WHERE pane_id = ? AND is_current = 1").run(timestamp, paneId));
    return;
  }
  if (event.event !== "pane.agent_status_changed" && event.event !== "pane_agent_status_changed") return;
  const agentStatus = string(event.data, "agent_status", "agentStatus", "status") ?? "unknown";
  const status = agentStatus === "working" ? "working" : agentStatus === "blocked" ? "blocked" : agentStatus === "idle" || agentStatus === "done" ? "ready" : undefined;
  database.authTransaction((db) => db.prepare(`UPDATE forge_herdr_role_sessions SET last_agent_status = ?, last_seen_at = ?, updated_at = ?, status = COALESCE(?, status) WHERE pane_id = ? AND is_current = 1`).run(agentStatus, timestamp, timestamp, status ?? null, paneId));
}

function knownPaneIds(database: ForgeDatabase): string[] {
  return database.authQuery((db) => db.prepare("SELECT pane_id AS paneId FROM forge_herdr_role_sessions WHERE is_current = 1 AND pane_id IS NOT NULL ORDER BY pane_id").all() as Array<{ paneId: string }>).map((row) => row.paneId);
}

export function startHerdrEventSubscriber(database: ForgeDatabase, options: { socketPath?: string; connect?: typeof connectHerdrSocket; logger?: Logger; refreshMs?: number } = {}): { stop(): void; reachable(): boolean } {
  const connect = options.connect ?? connectHerdrSocket;
  const refreshMs = options.refreshMs ?? 5_000;
  let stopped = false;
  let live = false;
  let socket: HerdrSocket | undefined;
  let subscribed = "";
  let retry = 0;
  let timer: NodeJS.Timeout | undefined;
  const schedule = (delay: number): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), delay);
  };
  // Every tick compares Forge's pane ids with the subscribed set and re-subscribes only on change.
  const tick = async (): Promise<void> => {
    if (socket && live && knownPaneIds(database).join(",") === subscribed) { schedule(refreshMs); return; }
    await run();
  };
  const run = async (): Promise<void> => {
    if (stopped) return;
    try {
      // Snapshot on its own connection: requests and pushed events never share a stream.
      const snapshotSocket = await connect(options.socketPath);
      let livePaneIds: Set<string>;
      try {
        const snapshot = await snapshotSocket.request<Record<string, unknown>>("session.snapshot", {});
        const body = snapshot.snapshot && typeof snapshot.snapshot === "object" ? snapshot.snapshot as Record<string, unknown> : snapshot;
        const panes = (Array.isArray(body.panes) ? body.panes : []).filter((pane): pane is Record<string, unknown> => Boolean(pane) && typeof pane === "object");
        for (const pane of panes) apply(database, { event: "pane.agent_status_changed", data: pane });
        livePaneIds = new Set(panes.map((pane) => string(pane, "pane_id")).filter((id): id is string => Boolean(id)));
      } finally { snapshotSocket.close(); }
      const known = knownPaneIds(database);
      const paneIds = known.filter((id) => livePaneIds.has(id));
      const next = await connect(options.socketPath);
      let closed = false;
      await next.subscribe(paneIds.flatMap((paneId) => eventTypes.map((type) => ({ type, pane_id: paneId }))), (event) => {
        if (event.event === "socket_closed") {
          if (closed) return;
          closed = true;
          if (socket === next) { socket = undefined; live = false; if (!stopped) schedule(nextDelay()); }
          return;
        }
        apply(database, event);
      });
      const previous = socket;
      socket = next;
      subscribed = known.join(",");
      live = true;
      retry = 0;
      previous?.close();
      schedule(refreshMs);
    } catch (error) {
      live = false;
      options.logger?.warn({ error: error instanceof Error ? error.message : "unknown" }, "Herdr event subscriber is unavailable");
      schedule(nextDelay());
    }
  };
  const nextDelay = (): number => {
    const delays = [1_000, 2_000, 5_000, 10_000, 30_000];
    return delays[Math.min(retry++, delays.length - 1)] ?? 30_000;
  };
  schedule(0);
  return {
    stop: () => { stopped = true; live = false; if (timer) clearTimeout(timer); socket?.close(); socket = undefined; },
    reachable: () => live,
  };
}
