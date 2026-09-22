import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { seconds: { type: "string", default: "60" }, log: { type: "string", default: ".forge/logs/api.log" } } });
const seconds = Number(values.seconds);
if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > 2_147_483_647) throw new Error("--seconds must be a positive duration supported by Node timers");

function family(rawUrl: string): string {
  const { pathname } = new URL(rawUrl, "http://localhost");
  if (/^\/api\/tasks\/[^/]+\/agents$/.test(pathname)) return "task agents (single)";
  if (/^\/api\/companies\/[^/]+\/task-agents$/.test(pathname)) return "task agents (batch)";
  if (/^\/api\/companies\/[^/]+\/tasks$/.test(pathname)) return "task list";
  if (/^\/api\/tasks\/[^/]+$/.test(pathname)) return "selected task";
  if (/^\/api\/companies\/[^/]+\/projects$/.test(pathname)) return "projects";
  const id = /^(?:[a-z][a-z0-9]*_)*[a-f0-9]{16,64}$|^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$|^\d+$/i;
  return pathname.split("/").map(segment => id.test(segment) ? ":id" : segment).join("/");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Completed request records use time, req.method, req.url, res.statusCode, responseTime, and msg="request".
function completed(line: string): { time: number; url: string } | undefined {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return undefined; }
  if (!record(value) || value.msg !== "request" || typeof value.time !== "string" || typeof value.responseTime !== "number") return undefined;
  if (!record(value.req) || typeof value.req.method !== "string" || typeof value.req.url !== "string") return undefined;
  if (!record(value.res) || typeof value.res.statusCode !== "number") return undefined;
  return { time: Date.parse(value.time), url: value.req.url };
}

const start = Date.now();
process.stderr.write(`Counting completed requests for ${seconds}s from ${new Date(start).toISOString()} in ${values.log}\n`);
await delay(seconds * 1000);
const end = Date.now();
const counts = new Map(["task agents (single)", "task agents (batch)", "task list", "selected task", "projects"].map(name => [name, 0]));
for await (const line of createInterface({ input: createReadStream(values.log), crlfDelay: Infinity })) {
  const entry = completed(line);
  if (!entry || !(entry.time >= start && entry.time <= end)) continue;
  const name = family(entry.url);
  counts.set(name, (counts.get(name) ?? 0) + 1);
}
const minutes = (end - start) / 60000;
process.stdout.write("| Family | Count | Count per minute |\n| --- | ---: | ---: |\n");
for (const [name, count] of [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))) {
  process.stdout.write(`| ${name.replaceAll("|", "\\|")} | ${count} | ${(count / minutes).toFixed(2)} |\n`);
}
process.stdout.write(`\nWindow start: ${new Date(start).toISOString()} UTC\nWindow end: ${new Date(end).toISOString()} UTC\n`);
