// ponytail: source-text counts include comments and remaining inline tests.
// Use a Rust parser if false positives make these review limits impractical.
// Lower counts always pass. Refresh the JSON deliberately with --write after
// reviewing reductions; CI never writes it.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const baselinePath = new URL("./rust-ratchet.json", import.meta.url);
const root = new URL("../rust/src/", import.meta.url);

function counts(source: string, file: string) {
  return {
    // Count direct paths and grouped imports such as serde_json::{Value, json}.
    serde_json_value: [...source.matchAll(/\bserde_json\s*::\s*(?:Value\b|\{[^}]*\bValue\b)/g)].length,
    io_error_other: [...source.matchAll(/\bio\s*::\s*Error\s*::\s*other\b/g)].length,
    sql_outside_storage: /(?:repository|store)\.rs$|^persistence\.rs$/.test(basename(file))
      ? 0
      : [...source.matchAll(/\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|JOIN)\b/g)].length,
  };
}

function exceeds(actual: ReturnType<typeof counts>, baseline: ReturnType<typeof counts>) {
  return actual.serde_json_value > baseline.serde_json_value
    || actual.io_error_other > baseline.io_error_other
    || actual.sql_outside_storage > baseline.sql_outside_storage;
}

if (process.argv.includes("--self-test")) {
  const source = 'serde_json::Value; serde_json::{json, Value}; std::io::Error::other("error"); SELECT INSERT UPDATE DELETE CREATE ALTER DROP JOIN';
  const actual = counts(source, "routes.rs");
  assert.deepEqual(actual, { serde_json_value: 2, io_error_other: 1, sql_outside_storage: 8 });
  for (const file of ["repository.rs", "task_repository.rs", "root_session_store.rs", "persistence.rs"]) {
    assert.deepEqual(counts(source, file), { ...actual, sql_outside_storage: 0 });
  }
  assert.equal(exceeds(actual, actual), false);
  assert.equal(exceeds(counts("", "routes.rs"), actual), false);
  for (const key of Object.keys(actual)) {
    assert.equal(exceeds({ ...actual, [key]: 100 }, actual), true);
  }
  console.log("Rust ratchet self-test passed.");
} else {
  const actual = counts("", "");
  for (const file of readdirSync(root, { recursive: true, encoding: "utf8" }).sort()) {
    if (!file.endsWith(".rs")) continue;
    const found = counts(readFileSync(new URL(file, root), "utf8"), file);
    actual.serde_json_value += found.serde_json_value;
    actual.io_error_other += found.io_error_other;
    actual.sql_outside_storage += found.sql_outside_storage;
  }
  if (process.argv.includes("--write")) {
    writeFileSync(baselinePath, `${JSON.stringify(actual, null, 2)}\n`);
  }
  const baseline: unknown = JSON.parse(readFileSync(baselinePath, "utf8"));
  assert.ok(typeof baseline === "object" && baseline !== null);
  assert.ok("serde_json_value" in baseline && typeof baseline.serde_json_value === "number");
  assert.ok("io_error_other" in baseline && typeof baseline.io_error_other === "number");
  assert.ok("sql_outside_storage" in baseline && typeof baseline.sql_outside_storage === "number");
  console.log(JSON.stringify({ actual, baseline }, null, 2));
  if (exceeds(actual, {
    serde_json_value: baseline.serde_json_value,
    io_error_other: baseline.io_error_other,
    sql_outside_storage: baseline.sql_outside_storage,
  })) {
    console.error("Rust source counts exceed scripts/rust-ratchet.json. Remove the regression.");
    process.exitCode = 1;
  }
}
