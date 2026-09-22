"use strict";
// Speaks C3's install protocol without a Suplex server behind it.
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const STAGES = [
  { name: "prerequisites", title: "Check this Mac" },
  { name: "developer-tools", title: "Install Apple developer tools (git)" },
  { name: "herdr", title: "Install Herdr terminals" },
  { name: "data", title: "Prepare Suplex data" },
  { name: "complete", title: "Finish" },
];

const dataRoot = process.env.SUPLEX_DATA_ROOT ?? ".";
const read = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(join(dataRoot, file), "utf8"));
  } catch {
    return fallback;
  }
};
const settings = read("fixture.json", {});
const failStage = process.env.SUPLEX_FIXTURE_FAIL_STAGE ?? settings.failStage ?? null;
const frame = (value) => { process.stdout.write(`${JSON.stringify(value)}\n`); process.exit(value.ok ? 0 : 1); };

const argv = process.argv.slice(2);
if (argv[0] !== "install") { process.stderr.write(`unknown command: ${argv[0] ?? ""}\n`); process.exit(1); }
if (argv.includes("--manifest")) { process.stdout.write(`${JSON.stringify({ protocolVersion: 1, stages: STAGES })}\n`); process.exit(0); }

const stage = argv[argv.indexOf("--stage") + 1];
const known = STAGES.find((entry) => entry.name === stage);
if (!known) { process.stderr.write(`unknown stage: ${stage ?? ""}\n`); process.exit(1); }

mkdirSync(dataRoot, { recursive: true });
const done = read("fixture-stages.json", []);
process.stderr.write(`${known.title}\n`);
if (done.includes(stage)) frame({ ok: true, stage, skipped: true, reason: "already done" });
if (stage === failStage) {
  process.stderr.write(`${stage} could not finish\n`);
  frame({ ok: false, stage, reason: settings.reason ?? `The ${stage} step failed.`, remedy: settings.remedy ?? "Fix it and retry." });
}
for (const line of ["checking", "working", "finished"]) process.stderr.write(`${stage}: ${line}\n`);
if (settings.delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, settings.delayMs);
writeFileSync(join(dataRoot, "fixture-stages.json"), JSON.stringify([...done, stage]));
frame({ ok: true, stage, skipped: false });
