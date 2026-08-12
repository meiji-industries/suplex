import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index]?.replace(/^--/, ""), process.argv[index + 1]);
const duration = Number(args.get("duration") ?? 250);
const ignoreTerm = args.get("ignore-term") === "true";
const ignoreTermDuration = Number(args.get("ignore-term-duration") ?? 0);
const heartbeatInterval = Number(args.get("heartbeat-interval") ?? 50);
const launchCount = args.get("launch-count");
const output = args.get("output");
const forkChild = args.get("fork-child") === "true";
const forkDuration = Number(args.get("fork-duration") ?? duration + 500);
const crash = args.get("crash") === "true";
const malformedJson = args.get("malformed-json") === "true";
const truncatedJson = args.get("truncated-json") === "true";

if (launchCount) writeFileSync(launchCount, `${process.pid}\n`, { flag: "wx" });
const write = (value) => {
  const line = `${JSON.stringify(value)}\n`;
  process.stdout.write(line);
  if (output) appendFileSync(output, line);
};
write({ kind: "heartbeat", status: "started", pid: process.pid });
if (ignoreTerm) process.on("SIGTERM", () => {
  if (ignoreTermDuration > 0) setTimeout(() => process.exit(0), ignoreTermDuration).unref();
  else setInterval(() => undefined, 1_000).unref();
});
if (forkChild) {
  const child = spawn(process.execPath, [process.argv[1], "--duration", String(forkDuration), "--ignore-term", "true"], { stdio: "ignore" });
  child.unref();
}
const interval = setInterval(() => write({ kind: "heartbeat", status: "running", pid: process.pid }), heartbeatInterval);
setTimeout(() => {
  clearInterval(interval);
  if (crash) process.exit(1);
  if (malformedJson) { process.stdout.write("{ malformed\n"); if (output) appendFileSync(output, "{ malformed\n"); process.exit(0); }
  const response = { kind: "delivery", summary: "Controlled Developer response", steps: [{ number: 1, status: "completed", filesChanged: [], commandsRun: [], testResults: [], notes: "controlled" }], authorizedStepsNotCompleted: [], resultCommit: "a".repeat(40), resultTree: "b".repeat(40), dirtyState: "clean", blocker: null };
  if (truncatedJson) { const line = JSON.stringify(response).slice(0, -2); process.stdout.write(line); if (output) appendFileSync(output, line); process.exit(0); }
  write({ ...response, status: "completed" });
  process.exit(0);
}, duration);
