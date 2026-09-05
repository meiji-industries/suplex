import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { ForgeDatabase } from "../src/database.js";

const source = process.argv[2];
if (!source) throw new Error("Usage: tsx scripts/probe-native-upgrade.ts <source-database>");
const directory = await mkdtemp(join(tmpdir(), "forge-native-upgrade-"));
await chmod(directory, 0o700);
const filename = join(directory, "forge.sqlite");
const backup = join(directory, "before.sqlite");
const original = new Database(resolve(source), { readonly: true, fileMustExist: true });
const retained = ["forge_users", "forge_companies", "forge_projects", "forge_hermes_agents"];
const count = (database: Database.Database, table: string): number => {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return 0;
  return z.object({ n: z.number() }).parse(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()).n;
};
let before: Record<string, number>;
let sourceWasNative: boolean;
try {
  before = Object.fromEntries([...retained, "forge_tasks"].map(table => [table, count(original, table)]));
  sourceWasNative = z.array(z.object({ name: z.string() })).parse(original.prepare("PRAGMA table_info(forge_tasks)").all()).some(column => column.name === "configuration_json");
  await original.backup(backup);
  await chmod(backup, 0o600);
  await copyFile(backup, filename);
  await chmod(filename, 0o600);
} finally { original.close(); }
const upgraded = new ForgeDatabase(filename);
try {
  const after = upgraded.authQuery(database => Object.fromEntries([...retained, "forge_tasks"].map(table => [table, count(database, table)])));
  for (const table of retained) assert.equal(after[table], before[table], `${table} must be retained`);
  assert.equal(after.forge_tasks, sourceWasNative ? before.forge_tasks : 0);
  assert.deepEqual(upgraded.authQuery(database => database.prepare("PRAGMA foreign_key_check").all()), []);
  assert.equal(upgraded.schemaStatus().state, "current");
  console.log(JSON.stringify({ source: resolve(source), backup, copy: filename, sourceUnchanged: true, before, after, schema: "current", foreignKeys: "valid" }, null, 2));
} finally { upgraded.close(); }
