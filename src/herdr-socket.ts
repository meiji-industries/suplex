import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import net from "node:net";

import { json } from "./task-utils.js";

export function herdrSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.HERDR_SOCKET_PATH ?? join(homedir(), ".config", "herdr", "herdr.sock");
}

export interface HerdrSocket {
  request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T>;
  subscribe(subscriptions: Array<Record<string, unknown>>, onEvent: (event: { event: string; data: Record<string, unknown> }) => void): Promise<() => void>;
  close(): void;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export async function connectHerdrSocket(path = herdrSocketPath()): Promise<HerdrSocket> {
  const socket = net.connect(path);
  await new Promise<void>((resolve, reject) => {
    const connected = (): void => { socket.off("error", failed); resolve(); };
    const failed = (error: Error): void => { socket.off("connect", connected); reject(error); };
    socket.once("connect", connected);
    socket.once("error", failed);
  });
  const pending = new Map<string, Pending>();
  let buffer = "";
  let closed = false;
  let subscription: ((event: { event: string; data: Record<string, unknown> }) => void) | undefined;
  const rejectPending = (error: Error): void => { for (const entry of pending.values()) entry.reject(error); pending.clear(); };
  const closedEvent = (): void => {
    if (closed) return;
    closed = true;
    rejectPending(new Error("socket_closed: Herdr socket closed"));
    subscription?.({ event: "socket_closed", data: {} });
  };
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      const parsed = json<Record<string, unknown> | null>(line, null);
      if (!parsed || typeof parsed !== "object") continue;
      message = parsed;
      if (typeof message.event === "string") { subscription?.({ event: message.event, data: (message.data ?? {}) as Record<string, unknown> }); continue; }
      const id = typeof message.id === "string" ? message.id : undefined;
      const entry = id ? pending.get(id) : undefined;
      if (!entry || !id) continue;
      pending.delete(id);
      if (message.error && typeof message.error === "object") {
        const error = message.error as Record<string, unknown>;
        entry.reject(new Error(`${String(error.code ?? "error")}: ${String(error.message ?? "Herdr request failed")}`));
      } else entry.resolve(message.result);
    }
  });
  socket.on("error", closedEvent);
  socket.on("close", closedEvent);
  const request = <T>(method: string, params: Record<string, unknown>): Promise<T> => new Promise<T>((resolve, reject) => {
    if (closed) { reject(new Error("socket_closed: Herdr socket closed")); return; }
    const id = randomUUID(); pending.set(id, { resolve: (value) => resolve(value as T), reject });
    socket.write(`${JSON.stringify({ id, method, params })}\n`, (error) => { if (error) { pending.delete(id); reject(error); } });
  });
  return {
    request,
    async subscribe(subscriptions, onEvent) {
      subscription = onEvent;
      await request("events.subscribe", { subscriptions });
      return () => socket.destroy();
    },
    close: () => socket.destroy(),
  };
}
