import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createInstaller, type InstallEvent } from "../src/installer";

const FIXTURE = join(__dirname, "fixtures", "runtime");

function workspace(settings?: Record<string, unknown>): string {
  const userData = mkdtempSync(join(tmpdir(), "suplex-desktop-install-"));
  mkdirSync(join(userData, "data"), { recursive: true });
  if (settings) writeFileSync(join(userData, "data", "fixture.json"), JSON.stringify(settings));
  return userData;
}

const installer = (userData: string): ReturnType<typeof createInstaller> =>
  createInstaller({ runtimeRoot: FIXTURE, userData, base: { HOME: process.env.HOME ?? "", USER: process.env.USER ?? "", TMPDIR: process.env.TMPDIR ?? "" } });

const collect = (): { events: InstallEvent[]; emit: (event: InstallEvent) => void } => {
  const events: InstallEvent[] = [];
  return { events, emit: (event) => { events.push(event); } };
};
const names = (events: InstallEvent[], name: InstallEvent["name"]): string[] =>
  events.flatMap((event) => (event.name === name && "stage" in event ? [event.stage] : []));

test("every stage runs in order, streams its log, and the run is written to a dated file", async () => {
  const userData = workspace();
  const { events, emit } = collect();
  expect(await installer(userData).run(null, emit)).toBe("complete");
  const stages = events.find((event) => event.name === "stages");
  expect(stages).toMatchObject({ from: 0 });
  expect(stages?.name === "stages" && stages.stages.map((stage) => stage.name)).toEqual(["prerequisites", "developer-tools", "herdr", "data", "complete"]);
  expect(names(events, "stage-started")).toEqual(["prerequisites", "developer-tools", "herdr", "data", "complete"]);
  expect(names(events, "stage-finished")).toEqual(["prerequisites", "developer-tools", "herdr", "data", "complete"]);
  expect(events.at(-1)).toEqual({ name: "done" });
  expect(events.flatMap((event) => (event.name === "log" ? [event.line] : []))).toContain("herdr: working");
  const logs = readdirSync(join(userData, "logs"));
  expect(logs.filter((name) => /^install-.+\.log$/.test(name))).toHaveLength(1);
  expect(readFileSync(join(userData, "logs", logs[0] ?? ""), "utf8")).toContain("Install Herdr terminals");
});

test("the first failure stops the run and carries the stage title, reason, and remedy", async () => {
  const userData = workspace({ failStage: "herdr", reason: "curl exited 22", remedy: "Check the network connection and retry." });
  const { events, emit } = collect();
  expect(await installer(userData).run(null, emit)).toBe("failed");
  expect(events.at(-1)).toEqual({ name: "failed", stage: "herdr", title: "Install Herdr terminals", reason: "curl exited 22", remedy: "Check the network connection and retry." });
  expect(names(events, "stage-started")).toEqual(["prerequisites", "developer-tools", "herdr"]);
});

test("a retry reruns from the failed stage, and the stages before it stay done", async () => {
  const userData = workspace({ failStage: "herdr", reason: "curl exited 22" });
  await installer(userData).run(null, collect().emit);
  writeFileSync(join(userData, "data", "fixture.json"), JSON.stringify({}));
  const { events, emit } = collect();
  expect(await installer(userData).run("herdr", emit)).toBe("complete");
  expect(events.find((event) => event.name === "stages")).toMatchObject({ from: 2 });
  expect(names(events, "stage-started")).toEqual(["herdr", "data", "complete"]);
  expect(JSON.parse(readFileSync(join(userData, "data", "fixture-stages.json"), "utf8"))).toEqual(["prerequisites", "developer-tools", "herdr", "data", "complete"]);
});

test("a completed stage reports itself as skipped on a rerun", async () => {
  const userData = workspace();
  await installer(userData).run(null, collect().emit);
  const { events, emit } = collect();
  expect(await installer(userData).run(null, emit)).toBe("complete");
  expect(events.filter((event) => event.name === "stage-finished").every((event) => event.name === "stage-finished" && event.skipped)).toBe(true);
});

test("Cancel kills the running stage's process group", async () => {
  const userData = workspace({ delayMs: 5_000 });
  const { events, emit } = collect();
  const driver = installer(userData);
  const run = driver.run(null, emit);
  await vi.waitFor(() => expect(events.some((event) => event.name === "log" && event.line === "prerequisites: finished")).toBe(true));
  driver.cancel();
  expect(await run).toBe("cancelled");
  expect(names(events, "stage-started")).toEqual(["prerequisites"]);
});

test("a runtime that is not there fails before any stage runs", async () => {
  const { events, emit } = collect();
  const driver = createInstaller({ runtimeRoot: join(FIXTURE, "missing"), userData: workspace(), base: {} });
  expect(await driver.run(null, emit)).toBe("failed");
  expect(events.at(-1)).toMatchObject({ name: "failed", title: "Read the install steps" });
});
