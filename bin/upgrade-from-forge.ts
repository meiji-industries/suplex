#!/usr/bin/env -S pnpm exec tsx
// Moves a Forge installation to Suplex. Stop Forge, then run this from the Suplex checkout:
//
//   bin/upgrade-from-forge.ts [forge-home ...]
//
// With no arguments it upgrades ./.forge and ~/Library/Application Support/Forge (the desktop app).
// For each home it renames the forge_* database schema to suplex_*, updates the stored paths and the
// migration hashes, renames forge.env to suplex.env with SUPLEX_* keys, and moves the folder.
// ~/forge/repos and ~/forge/worktrees stay in place; suplex.env points Suplex at them.
// Projects and git remotes for meiji-industries/forge move to meiji-industries/suplex, the renamed GitHub repository.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { runCommandSync } from "../src/platform/command-runner.js";
import { readMigrations, SuplexDatabase } from "../src/platform/database.js";

const rebrand = (text: string): string => text.replace(/forge(?![dt])/g, "suplex").replace(/Forge(?![dt])/g, "Suplex").replace(/FORGE/g, "SUPLEX");
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

function retargetRemotes(repository: string): void {
  if (!existsSync(join(repository, ".git"))) return;
  const git = (...args: string[]) => runCommandSync({ command: "git", args: ["-C", repository, ...args] }).trim();
  for (const remote of git("remote").split("\n").filter(Boolean)) {
    const url = git("remote", "get-url", remote);
    if (/meiji-industries\/forge(?:\.git)?\/?$/i.test(url)) git("remote", "set-url", remote, url.replace(/meiji-industries\/forge/i, "meiji-industries/suplex"));
  }
}

function upgradeDatabase(file: string, from: string, to: string): string[] {
  let repositories: string[] = [];
  const hashes = new Map(readMigrations(resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle")).map((migration) => [migration.createdAt, migration.hash]));
  const db = new Database(file, { fileMustExist: true });
  db.pragma("busy_timeout = 0");
  // Every schema object came from a migration, so rewriting the schema text the same way the migrations
  // were rewritten gives exactly the schema a new Suplex database has. Row storage is positional.
  db.unsafeMode(true);
  db.function("rebrand", (text: string | null) => text === null ? null : rebrand(text));
  db.transaction(() => {
    const version = db.pragma("schema_version", { simple: true }) as number;
    db.pragma("writable_schema = ON");
    db.exec("UPDATE sqlite_master SET name = rebrand(name), tbl_name = rebrand(tbl_name), sql = rebrand(sql)");
    db.pragma(`schema_version = ${version + 1}`);
    db.pragma("writable_schema = OFF");
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get()) db.exec("UPDATE sqlite_sequence SET name = rebrand(name)");
    // Stored paths move with the folder. Immutability triggers would reject that, so set them aside.
    const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string; sql: string }>;
    for (const trigger of triggers) db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
    for (const { name: table } of tables) {
      for (const { name: column } of db.pragma(`table_info(${quote(table)})`) as Array<{ name: string }>) {
        db.prepare(`UPDATE ${quote(table)} SET ${quote(column)} = replace(${quote(column)}, ?, ?) WHERE typeof(${quote(column)}) = 'text' AND instr(${quote(column)}, ?) > 0`).run(from, to, from);
      }
    }
    for (const trigger of triggers) db.exec(trigger.sql);
    if ((db.pragma("table_info(suplex_projects)") as Array<{ name: string }>).some((column) => column.name === "repository_identity")) {
      repositories = db.prepare("UPDATE suplex_projects SET repository_identity = 'meiji-industries/suplex' WHERE repository_identity = 'meiji-industries/forge' RETURNING repository_path").pluck().all() as string[];
    }
    const setHash = db.prepare("UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?");
    for (const { created_at } of db.prepare("SELECT created_at FROM __drizzle_migrations").all() as Array<{ created_at: number }>) {
      const hash = hashes.get(created_at);
      if (hash) setHash.run(hash, created_at);
    }
    const integrity = db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error(`${file}: integrity check failed after the rename: ${String(integrity)}`);
  })();
  db.close();
  return repositories;
}

function upgradeEnvironment(file: string, from: string, to: string): string {
  const lines = existsSync(file) ? readFileSync(file, "utf8").replaceAll(from, to).replace(/^(\s*(?:export\s+)?)FORGE_/gm, "$1SUPLEX_").split("\n").filter(Boolean) : [];
  for (const [key, folder] of [["SUPLEX_REPOSITORY_ROOT", "repos"], ["SUPLEX_WORKTREE_ROOT", "worktrees"]] as const) {
    const legacy = join(homedir(), "forge", folder);
    if (existsSync(legacy) && !lines.some((line) => line.trim().startsWith(`${key}=`))) lines.push(`${key}=${legacy}`);
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

function upgradeHome(from: string): void {
  const to = join(dirname(from), rebrand(basename(from)));
  if (existsSync(to)) throw new Error(`${to} already exists. Move it aside, then run this again.`);
  const environment = upgradeEnvironment(join(from, "forge.env"), from, to);
  if (/^\s*(?:export\s+)?SUPLEX_(?:DATA_ROOT|DATABASE_PATH)=/m.test(environment)) throw new Error(`${from}/forge.env sets a custom data path. Upgrade that installation by hand.`);
  const database = join(from, "data", "forge.sqlite");
  const repositories = existsSync(database) ? upgradeDatabase(database, from, to) : [];
  renameSync(from, to);
  for (const repository of repositories) retargetRemotes(repository);
  if (existsSync(join(to, "data", "forge.sqlite"))) renameSync(join(to, "data", "forge.sqlite"), join(to, "data", "suplex.sqlite"));
  if (existsSync(join(to, "forge.env"))) renameSync(join(to, "forge.env"), join(to, "suplex.env"));
  if (environment) writeFileSync(join(to, "suplex.env"), environment, { mode: 0o600 });
  if (existsSync(join(to, "data", "suplex.sqlite"))) {
    const upgraded = new SuplexDatabase(join(to, "data", "suplex.sqlite"), { migrate: false });
    const { state, applied, expected } = upgraded.schemaStatus();
    upgraded.close();
    if (state !== "current" && state !== "behind") throw new Error(`${to}: schema ${state} after the upgrade`);
    console.log(`${from} -> ${to} (${applied.length}/${expected.length} migrations${state === "behind" ? "; Suplex applies the rest when it starts" : ""})`);
  } else console.log(`${from} -> ${to}`);
}

const homes = process.argv.length > 2
  ? process.argv.slice(2).map((home) => resolve(home))
  : [resolve(".forge"), join(homedir(), "Library", "Application Support", "Forge")].filter((home) => existsSync(home));
if (!homes.length) throw new Error("No Forge installation found. Give the path of a .forge folder.");
for (const home of homes) upgradeHome(home);
retargetRemotes(process.cwd());
const config = join(homedir(), ".config", "forge");
if (existsSync(config) && !existsSync(join(homedir(), ".config", "suplex"))) renameSync(config, join(homedir(), ".config", "suplex"));
