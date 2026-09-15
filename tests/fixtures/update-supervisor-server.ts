import { appendFileSync, existsSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const port = Number(process.env.FORGE_SUPERVISOR_TEST_PORT);
const startLog = process.env.FORGE_SUPERVISOR_TEST_START_LOG;
const failReady = process.env.FORGE_SUPERVISOR_TEST_FAIL_READY;
const lateReady = process.env.FORGE_SUPERVISOR_TEST_LATE_READY;
if (!port || !startLog || !failReady || !lateReady) throw new Error("Supervisor test environment is incomplete");
appendFileSync(startLog, `${process.pid}\n`);
if (existsSync(failReady)) {
  rmSync(failReady);
  process.exit(23);
}
const reportReady = !existsSync(lateReady);
if (!reportReady) {
  process.once("SIGTERM", () => {
    rmSync(lateReady);
    process.send?.({ kind: "ready", instanceId: randomUUID() });
    setTimeout(() => process.exit(0), 50);
  });
}

let sequence = 0;
const pending = new Map<string, (value: unknown) => void>();
process.on("message", (message: unknown) => {
  if (!message || typeof message !== "object") return;
  if ("kind" in message && message.kind === "shutdown") { void shutdown(); return; }
  if (!("requestId" in message) || typeof message.requestId !== "string") return;
  pending.get(message.requestId)?.(message);
  pending.delete(message.requestId);
});
process.once("disconnect", () => void shutdown());

function parent(kind: "update:read" | "update:apply", check = false): Promise<unknown> {
  const requestId = `request-${process.pid}-${sequence++}`;
  return new Promise((resolve) => {
    pending.set(requestId, resolve);
    process.send?.(kind === "update:read" ? { kind, requestId, check } : { kind, requestId });
  });
}

const server = createServer((request, response) => {
  if (request.url?.startsWith("/update")) {
    void parent("update:read", request.url.includes("check=1")).then((value) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); });
    return;
  }
  if (request.url === "/apply" && request.method === "POST") {
    void parent("update:apply").then((value) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); });
    return;
  }
  response.statusCode = 404;
  response.end();
});

function shutdown(): void {
  server.close(() => process.exit(0));
}

server.listen(port, "127.0.0.1", () => { if (reportReady) process.send?.({ kind: "ready", instanceId: randomUUID() }); });
