// ponytail: source-text counts include comments and remaining inline tests.
// Use a Rust parser if false positives make these review limits impractical.
// Lower counts always pass. Refresh the JSON deliberately with --write after
// reviewing reductions; CI never writes it.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const baselinePath = new URL("./rust-ratchet.json", import.meta.url);
const roots = {
  rust: { dir: new URL("../rust/src/", import.meta.url), extensions: [".rs"] },
  frontend: { dir: new URL("../src/frontend/", import.meta.url), extensions: [".ts", ".tsx"] },
};
type Root = keyof typeof roots;

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
  // Frontend reads that cast a response body without validating it.
  read_json_unchecked: /\breadJsonUnchecked\s*[<(]/g,
  as_unknown_as: /\bas unknown as\b/g,
};
type Counts = Record<keyof typeof patterns, number>;
const keys = Object.keys(patterns) as (keyof typeof patterns)[];
const frontendKeys: (keyof typeof patterns)[] = ["read_json_unchecked", "as_unknown_as"];
const rootOf = (key: keyof typeof patterns): Root => (frontendKeys.includes(key) ? "frontend" : "rust");

function counts(source: string, file: string, root: Root): Counts {
  const exempt: Partial<Record<keyof typeof patterns, boolean>> = {
    sql_outside_storage: /(?:repository|store)\.rs$|^persistence\.rs$/.test(basename(file)),
    block_on_outside_shared: /(?:^|\/)shared\/blocking\.rs$/.test(file),
  };
  return Object.fromEntries(
    keys.map((key) => [key, exempt[key] || rootOf(key) !== root ? 0 : [...source.matchAll(patterns[key])].length]),
  ) as Counts;
}

function exceeds(actual: Counts, baseline: Counts) {
  return keys.some((key) => actual[key] > baseline[key]);
}

if (process.argv.includes("--self-test")) {
  const source = 'serde_json::Value; serde_json::{json, Value}; std::io::Error::other("error"); SELECT INSERT UPDATE DELETE CREATE ALTER DROP JOIN; v["taskId"]; x.unwrap_or(""); block_on(f); SuplexDatabase::open(p)';
  const actual = counts(source, "routes.rs", "rust");
  assert.deepEqual(actual, {
    serde_json_value: 2, io_error_other: 1, sql_outside_storage: 8, json_field_index: 1,
    empty_string_default: 1, block_on_outside_shared: 1, database_open: 1,
    read_json_unchecked: 0, as_unknown_as: 0,
  });
  for (const file of ["repository.rs", "task_repository.rs", "root_session_store.rs", "persistence.rs"]) {
    assert.deepEqual(counts(source, file, "rust"), { ...actual, sql_outside_storage: 0 });
  }
  assert.deepEqual(counts(source, "shared/blocking.rs", "rust"), { ...actual, block_on_outside_shared: 0 });
  const tsSource = 'export async function readJsonUnchecked<T>(url: string) {} readJsonUnchecked<Task>("/a"); readJsonUnchecked ("/b"); const f = readJsonUnchecked; x as unknown as Task; x as unknown; v["taskId"]';
  assert.deepEqual(counts(tsSource, "features/tasks/task-api.ts", "frontend"), {
    ...counts("", "", "rust"), read_json_unchecked: 3, as_unknown_as: 1,
  });
  assert.equal(exceeds(actual, actual), false);
  assert.equal(exceeds(counts("", "routes.rs", "rust"), actual), false);
  for (const key of keys) {
    assert.equal(exceeds({ ...actual, [key]: 100 }, actual), true);
  }
  console.log("Ratchet self-test passed.");
} else {
  const actual = counts("", "", "rust");
  for (const [root, { dir, extensions }] of Object.entries(roots) as [Root, (typeof roots)[Root]][]) {
    for (const file of readdirSync(dir, { recursive: true, encoding: "utf8" }).sort()) {
      if (!extensions.some((extension) => file.endsWith(extension))) continue;
      const found = counts(readFileSync(new URL(file, dir), "utf8"), file, root);
      for (const key of keys) actual[key] += found[key];
    }
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
    console.error("Source counts exceed scripts/rust-ratchet.json. Remove the regression.");
    process.exitCode = 1;
  }
}
