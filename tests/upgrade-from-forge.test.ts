import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { expect, test } from "vitest";

import { runCommand } from "../src/platform/command-runner.js";
import { SuplexDatabase } from "../src/platform/database.js";

const unbrand = (text: string | null) => text?.replaceAll("suplex", "forge").replaceAll("Suplex", "Forge").replaceAll("SUPLEX", "FORGE") ?? null;
const schema = (file: string) => {
  const db = new Database(file, { readonly: true });
  try { return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT IN ('__drizzle_migrations', 'probe') ORDER BY type, name").all(); } finally { db.close(); }
};

test("bin/upgrade-from-forge.ts turns a Forge home into a Suplex home with the schema a new database has", async () => {
  const root = mkdtempSync(join(tmpdir(), "upgrade-from-forge-"));
  const fresh = join(root, "fresh.sqlite");
  new SuplexDatabase(fresh).close();
  const home = join(root, ".forge");
  mkdirSync(join(home, "data"), { recursive: true });
  copyFileSync(fresh, join(home, "data", "forge.sqlite"));
  const old = new Database(join(home, "data", "forge.sqlite"));
  old.pragma("foreign_keys = OFF");
  const clone = join(root, "clone");
  mkdirSync(clone);
  old.prepare("INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, created_at, updated_at) VALUES ('project', 'company', 'Suplex', ?, ?, 'meiji-industries/forge', 'main', '', '', '', '')").run(clone, join(root, "worktrees"));
  old.unsafeMode(true);
  old.function("unbrand", unbrand);
  old.pragma("writable_schema = ON");
  old.exec("UPDATE sqlite_master SET name = unbrand(name), tbl_name = unbrand(tbl_name), sql = unbrand(sql)");
  old.pragma("writable_schema = OFF");
  old.exec("UPDATE __drizzle_migrations SET hash = 'forge'; CREATE TABLE probe (path TEXT)");
  old.prepare("INSERT INTO probe VALUES (?)").run(join(home, "data", "runtime", "session"));
  old.close();
  writeFileSync(join(home, "forge.env"), "FORGE_PORT=4111\n");
  const git = (...args: string[]) => runCommand({ taskId: null, stepId: null, command: "git", args: ["-C", clone, ...args] });
  await git("init", "-q");
  await git("remote", "add", "origin", "git@github.com:meiji-industries/forge.git");

  const upgrade = await runCommand({ taskId: null, stepId: null, command: join(process.cwd(), "node_modules", ".bin", "tsx"), args: [join(process.cwd(), "bin", "upgrade-from-forge.ts"), home], cwd: root, env: { ...process.env, HOME: root } });
  expect(upgrade.exitCode, upgrade.stderr).toBe(0);

  const upgraded = join(root, ".suplex", "data", "suplex.sqlite");
  expect(schema(upgraded)).toEqual(schema(fresh));
  const database = new SuplexDatabase(upgraded, { migrate: false });
  try {
    expect(database.schemaStatus().state).toBe("current");
    expect(database.authQuery((db) => db.prepare("SELECT path FROM probe").pluck().get())).toBe(join(root, ".suplex", "data", "runtime", "session"));
    expect(database.authQuery((db) => db.prepare("SELECT repository_identity FROM suplex_projects").pluck().get())).toBe("meiji-industries/suplex");
  } finally { database.close(); }
  expect(readFileSync(join(root, ".suplex", "suplex.env"), "utf8")).toBe("SUPLEX_PORT=4111\n");
  expect((await git("remote", "get-url", "origin")).stdout.trim()).toBe("git@github.com:meiji-industries/suplex.git");
});
