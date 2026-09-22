// eslint-disable-next-line no-restricted-imports -- this test kills the caller to verify an orphaned command retains its OS lock.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { sharedResourceCommand } from "../src/tasks/preparation.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "suplex-resource-command-"));
  directories.push(path);
  return { path, events: join(path, "events") };
}
function run(resource: string, events: string, name: string, seconds: number, orphan = false) {
  const script = `import os,time,sys\np=sys.argv[1]\n${orphan ? "if os.fork(): os._exit(0)\n" : ""}with open(p,'a') as f: f.write(sys.argv[2]+' start\\n')\ntime.sleep(float(sys.argv[3]))\nwith open(p,'a') as f: f.write(sys.argv[2]+' end\\n')`;
  const child = spawn("python3", [sharedResourceCommand(), "--resource", resource, "--", "python3", "-c", script, events, name, String(seconds)], { stdio: "ignore" });
  const exit = new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  return { child, exit };
}
async function waitFor(path: string, text: string) {
  for (let i = 0; i < 100; i++) {
    if ((await readFile(path, "utf8").catch(() => "")).includes(text)) return;
    await delay(25);
  }
  throw new Error(`Command did not produce ${text}`);
}

test("commands sharing a resource serialize while independent resources remain concurrent", async () => {
  const f = await fixture();
  const first = run(f.path, f.events, "first", 0.7);
  await waitFor(f.events, "first start");
  const second = run(f.path, f.events, "second", 0);
  const independent = run(`${f.path}-other`, f.events, "independent", 0);
  expect(await independent.exit).toBe(0);
  expect(await readFile(f.events, "utf8")).not.toContain("second start");
  expect(await first.exit).toBe(0);
  expect(await second.exit).toBe(0);
  const result = await readFile(f.events, "utf8");
  expect(result.indexOf("first end")).toBeLessThan(result.indexOf("second start"));
});

test("caller death retains the lock for a surviving child group and leaves no stale lock", async () => {
  const f = await fixture();
  const first = run(f.path, f.events, "orphan", 0.8, true);
  await waitFor(f.events, "orphan start");
  first.child.kill("SIGKILL");
  await first.exit;
  const second = run(f.path, f.events, "second", 0);
  await waitFor(f.events, "second end");
  expect(await second.exit).toBe(0);
  const result = await readFile(f.events, "utf8");
  expect(result.indexOf("orphan end")).toBeLessThan(result.indexOf("second start"));
  expect(await run(f.path, f.events, "third", 0).exit).toBe(0);
});

test("interrupting the caller stops the command group and releases the lock", async () => {
  const f = await fixture();
  const first = run(f.path, f.events, "cancelled", 30);
  await waitFor(f.events, "cancelled start");
  first.child.kill("SIGTERM");
  expect(await first.exit).toBe(143);
  expect(await run(f.path, f.events, "next", 0).exit).toBe(0);
  expect(await readFile(f.events, "utf8")).not.toContain("cancelled end");
});
