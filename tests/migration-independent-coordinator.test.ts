import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";

const migration = ["20260928153003373_seed_independent_coordinator.sql", "20260928153056880_rename_alt_coordinator.sql"]
  .map(file => readFileSync(new URL(`../apps/server/migrations/${file}`, import.meta.url), "utf8")).join("\n");

test("seeds a distinct advisor and preserves custom assignments and profile settings", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(readFileSync(new URL("../apps/server/migrations/20260907152227784_workflow_records.sql", import.meta.url), "utf8"));
    database.exec(`CREATE TABLE suplex_profiles (id TEXT PRIMARY KEY, name TEXT UNIQUE, role TEXT, avatar_seed TEXT, provider TEXT, model TEXT, reasoning_level TEXT, service_tier TEXT, provider_instance_id TEXT, archived_at TEXT, created_at TEXT, updated_at TEXT);
      INSERT INTO suplex_profiles VALUES ('profile_native_root', 'Smart Coordinator', 'root', 'original', 'codex', 'configured-model', 'high', 'priority', 'my-login', NULL, 'before', 'before');
      UPDATE suplex_workflows SET configuration_json = '{"deliveryTarget":"branch","advisorProfileIds":{"planner_a":"custom-planner","planner_b":"profile_native_root"}}' WHERE engine = 'competing_plans';`);
    database.exec(migration);
    const profile = () => database.prepare("SELECT * FROM suplex_profiles WHERE id = 'profile_native_independent'").get();
    expect(profile()).toMatchObject({ name: "Alt Coordinator", role: "root", provider: "codex", model: "configured-model", reasoning_level: "high", service_tier: "priority", provider_instance_id: "my-login" });
    expect(profile()?.avatar_seed).not.toBe("original");
    const config = (engine: string) => JSON.parse(String(database.prepare("SELECT configuration_json FROM suplex_workflows WHERE engine = ?").get(engine)?.configuration_json));
    expect(config("competing_plans")).toEqual({ deliveryTarget: "branch", advisorProfileIds: { planner_a: "custom-planner", planner_b: "profile_native_independent" } });
    expect(config("independent_review").advisorProfileIds.reviewer).toBe("profile_native_independent");
    expect(config("refine_pull_request").advisorProfileIds.rater).toBe("profile_native_independent");
    expect(config("standard")).toEqual({});
    database.exec(`UPDATE suplex_workflows SET configuration_json = '{"advisorProfileIds":{"reviewer":"custom-reviewer"}}' WHERE engine = 'independent_review'; UPDATE suplex_profiles SET name = 'My advisor' WHERE id = 'profile_native_independent';`);
    database.exec(migration);
    expect(config("independent_review").advisorProfileIds.reviewer).toBe("custom-reviewer");
    expect(profile()?.name).toBe("My advisor");
    expect(database.prepare("SELECT count(*) AS count FROM suplex_profiles").get()?.count).toBe(2);
  } finally { database.close(); }
});

test("projects inherit Alt Coordinator without overriding provider restrictions or custom workflows", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`CREATE TABLE suplex_profiles (id TEXT, role TEXT, archived_at TEXT, provider TEXT, provider_instance_id TEXT);
      INSERT INTO suplex_profiles VALUES ('profile_native_independent', 'root', NULL, 'codex', NULL);
      CREATE TABLE suplex_projects (id TEXT, root_profile_id TEXT, provider_policy_json TEXT);
      INSERT INTO suplex_projects VALUES ('unrestricted', 'root', NULL), ('restricted', 'root', '{"allowedProviders":["claude-code"],"allowedInstanceIds":[]}'), ('allowed', 'root', '{"allowedProviders":["codex"],"allowedInstanceIds":[]}');`);
    database.exec(readFileSync(new URL("../apps/server/migrations/20260907152227784_workflow_records.sql", import.meta.url), "utf8"));
    database.exec(`UPDATE suplex_workflows SET configuration_json = '{"advisorProfileIds":{"reviewer":"profile_native_independent"}}' WHERE engine = 'independent_review';
      UPDATE suplex_workflows SET configuration_json = '{"advisorProfileIds":{"rater":"custom"}}' WHERE engine = 'refine_pull_request';`);
    database.exec(readFileSync(new URL("../apps/server/migrations/20260928155244245_project_alt_coordinator_default.sql", import.meta.url), "utf8"));
    expect(database.prepare("SELECT id, alt_profile_id FROM suplex_projects ORDER BY id").all()).toEqual([
      { id: "allowed", alt_profile_id: "profile_native_independent" },
      { id: "restricted", alt_profile_id: "root" },
      { id: "unrestricted", alt_profile_id: "profile_native_independent" },
    ]);
    expect(JSON.parse(String(database.prepare("SELECT configuration_json FROM suplex_workflows WHERE engine = 'independent_review'").get()?.configuration_json))).toEqual({ advisorProfileIds: {} });
    expect(JSON.parse(String(database.prepare("SELECT configuration_json FROM suplex_workflows WHERE engine = 'refine_pull_request'").get()?.configuration_json))).toEqual({ advisorProfileIds: { rater: "custom" } });
  } finally { database.close(); }
});

test("coordinator avatar swap changes only the original default seeds", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`CREATE TABLE suplex_profiles (id TEXT PRIMARY KEY, avatar_seed TEXT);
      INSERT INTO suplex_profiles VALUES ('profile_native_root', '00000000000000000000000000000001'), ('profile_native_independent', '00000000000000000000000000000003');`);
    const sql = readFileSync(new URL("../apps/server/migrations/20260928160550554_swap_coordinator_avatars.sql", import.meta.url), "utf8");
    database.exec(sql);
    const seeds = () => database.prepare("SELECT avatar_seed FROM suplex_profiles ORDER BY id").all().map(row => row.avatar_seed);
    expect(seeds()).toEqual(["00000000000000000000000000000001", "00000000000000000000000000000003"]);
    database.exec(sql);
    expect(seeds()).toEqual(["00000000000000000000000000000001", "00000000000000000000000000000003"]);
    database.exec("UPDATE suplex_profiles SET avatar_seed = 'custom'");
    database.exec(sql);
    expect(seeds()).toEqual(["custom", "custom"]);
  } finally { database.close(); }
});
