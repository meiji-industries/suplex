import type { ForgeDatabase } from "./database.js";
import { connectHerdrSocket, type HerdrSocket } from "./herdr-socket.js";
import type { Logger } from "pino";

type Event = { event: string; data: Record<string, unknown> };
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

export function startHerdrEventSubscriber(database: ForgeDatabase, options: { socketPath?: string; connect?: typeof connectHerdrSocket; logger?: Logger } = {}): { stop(): void; reachable(): boolean } {
  const connect = options.connect ?? connectHerdrSocket;
  let stopped = false;
  let live = false;
  let socket: HerdrSocket | undefined;
  let retry = 0;
  let timer: NodeJS.Timeout | undefined;
  const run = async (): Promise<void> => {
    try {
      socket = await connect(options.socketPath);
      const unsubscribe = await socket.subscribe(eventTypes.map((type) => ({ type })), (event) => {
        if (event.event === "socket_closed") { live = false; socket = undefined; if (!stopped) schedule(); return; }
        apply(database, event);
      });
      live = true; retry = 0;
      // Snapshot uses a separate request stream so subscription events cannot race responses.
      const snapshotSocket = await connect(options.socketPath);
      try {
        const snapshot = await snapshotSocket.request<Record<string, unknown>>("session.snapshot", {});
        const panes = Array.isArray(snapshot.panes) ? snapshot.panes : Array.isArray(snapshot) ? snapshot : [];
        for (const pane of panes) if (pane && typeof pane === "object") apply(database, { event: "pane.agent_status_changed", data: pane as Record<string, unknown> });
      } finally { snapshotSocket.close(); }
      void unsubscribe;
    } catch (error) {
      live = false;
      options.logger?.warn({ error: error instanceof Error ? error.message : "unknown" }, "Herdr event subscriber is unavailable");
      if (!stopped) schedule();
    }
  };
  const schedule = (): void => {
    const delays = [1_000, 2_000, 5_000, 10_000, 30_000];
    const delay = delays[Math.min(retry++, delays.length - 1)];
    timer = setTimeout(() => void run(), delay);
  };
  void run();
  return { stop: () => { stopped = true; live = false; if (timer) clearTimeout(timer); socket?.close(); }, reachable: () => live };
}
