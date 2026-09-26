// ponytail: source-text counts include comments and remaining inline tests.
// Use a Rust parser if false positives make these review limits impractical.
// Lower counts always pass. Refresh the JSON deliberately with --write after
// reviewing reductions; CI never writes it.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const baselinePath = new URL("./rust-ratchet.json", import.meta.url);
const root = new URL("../rust/src/", import.meta.url);

const patterns = {
  // Direct paths and grouped imports such as serde_json::{Value, json}.
  serde_json_value: /\bserde_json\s*::\s*(?:Value\b|\{[^}]*\bValue\b)/g,
  io_error_other: /\bio\s*::\s*Error\s*::\s*other\b/g,
  sql_outside_storage: /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|JOIN)\b/g,
  // Untyped JSON reads and silent defaults for missing fields.
  json_field_index: /\["[A-Za-z_]+"\]/g,
  empty_string_default: /\.unwrap_or\(\s*""\s*\)/g,
  // Only shared/blocking.rs may bridge async code from sync code.
  block_on_outside_shared: /\bblock_on\b/g,
  database_open: /\bSuplexDatabase::open\b/g,
};
type Counts = Record<keyof typeof patterns, number>;
const keys = Object.keys(patterns) as (keyof typeof patterns)[];

function counts(source: string, file: string): Counts {
  const exempt: Partial<Record<keyof typeof patterns, boolean>> = {
    sql_outside_storage: /(?:repository|store)\.rs$|^persistence\.rs$/.test(basename(file)),
    block_on_outside_shared: /(?:^|\/)shared\/blocking\.rs$/.test(file),
  };
  return Object.fromEntries(
    keys.map((key) => [key, exempt[key] ? 0 : [...source.matchAll(patterns[key])].length]),
  ) as Counts;
}

function exceeds(actual: Counts, baseline: Counts) {
  return keys.some((key) => actual[key] > baseline[key]);
}

if (process.argv.includes("--self-test")) {
  const source = 'serde_json::Value; serde_json::{json, Value}; std::io::Error::other("error"); SELECT INSERT UPDATE DELETE CREATE ALTER DROP JOIN; v["taskId"]; x.unwrap_or(""); block_on(f); SuplexDatabase::open(p)';
  const actual = counts(source, "routes.rs");
  assert.deepEqual(actual, {
    serde_json_value: 2, io_error_other: 1, sql_outside_storage: 8, json_field_index: 1,
    empty_string_default: 1, block_on_outside_shared: 1, database_open: 1,
  });
  for (const file of ["repository.rs", "task_repository.rs", "root_session_store.rs", "persistence.rs"]) {
    assert.deepEqual(counts(source, file), { ...actual, sql_outside_storage: 0 });
  }
  assert.deepEqual(counts(source, "shared/blocking.rs"), { ...actual, block_on_outside_shared: 0 });
  assert.equal(exceeds(actual, actual), false);
  assert.equal(exceeds(counts("", "routes.rs"), actual), false);
  for (const key of keys) {
    assert.equal(exceeds({ ...actual, [key]: 100 }, actual), true);
  }
  console.log("Rust ratchet self-test passed.");
} else {
  const actual = counts("", "");
  for (const file of readdirSync(root, { recursive: true, encoding: "utf8" }).sort()) {
    if (!file.endsWith(".rs")) continue;
    const found = counts(readFileSync(new URL(file, root), "utf8"), file);
    for (const key of keys) actual[key] += found[key];
  }
  if (process.argv.includes("--write")) {
    writeFileSync(baselinePath, `${JSON.stringify(actual, null, 2)}\n`);
  }
  const baseline: unknown = JSON.parse(readFileSync(baselinePath, "utf8"));
  assert.ok(typeof baseline === "object" && baseline !== null);
  for (const key of keys) {
    assert.ok(key in baseline && typeof (baseline as Record<string, unknown>)[key] === "number", `${key} is missing from the baseline`);
  }
  console.log(JSON.stringify({ actual, baseline }, null, 2));
  if (exceeds(actual, baseline as Counts)) {
    console.error("Rust source counts exceed scripts/rust-ratchet.json. Remove the regression.");
    process.exitCode = 1;
  }
}
