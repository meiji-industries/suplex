import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync as Database } from "node:sqlite";
import { expect, test } from "vitest";

test("tracks task status changes without treating control writes as status changes", () => {
    const folder = resolve(process.cwd(), "drizzle");
    const database = new Database(":memory:", { enableForeignKeyConstraints: false });
    try {
      const migration = readdirSync(folder).find((candidate) => candidate.includes("task_status_change_timestamp"))!;
      database.exec("CREATE TABLE suplex_task_controls (task_id TEXT PRIMARY KEY, status TEXT NOT NULL, wake_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO suplex_task_controls (task_id, status, wake_at, created_at, updated_at) VALUES ('task-1', 'backlog', NULL, '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z');");

      for (const statement of readFileSync(`${folder}/${migration}`, "utf8").split("--> statement-breakpoint")) {
        if (statement.trim()) database.exec(statement);
      }

      expect(database.prepare("SELECT status_changed_at FROM suplex_task_controls WHERE task_id = 'task-1'").get()).toEqual({ status_changed_at: "2020-01-02T00:00:00.000Z" });
      database.prepare("UPDATE suplex_task_controls SET wake_at = ?, updated_at = ? WHERE task_id = ?").run("2020-01-03T00:00:00.000Z", "2020-01-03T00:00:00.000Z", "task-1");
      expect(database.prepare("SELECT status_changed_at FROM suplex_task_controls WHERE task_id = 'task-1'").get()).toEqual({ status_changed_at: "2020-01-02T00:00:00.000Z" });
      database.prepare("UPDATE suplex_task_controls SET status = ?, updated_at = ? WHERE task_id = ?").run("active", "2020-01-04T00:00:00.000Z", "task-1");
      expect(database.prepare("SELECT status_changed_at FROM suplex_task_controls WHERE task_id = 'task-1'").get()).not.toEqual({ status_changed_at: "2020-01-02T00:00:00.000Z" });
    } finally {
      database.close();
    }
  });

test("gives internal agents that share a profile independent settings rows", () => {
    const folder = resolve(process.cwd(), "drizzle");
    const database = new Database(":memory:", { enableForeignKeyConstraints: false });
    try {
      const migration = readdirSync(folder).find((candidate) => candidate.includes("collapse_profiles_into_agents"))!;
      database.exec("CREATE TABLE suplex_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, provider TEXT NOT NULL, model TEXT NOT NULL, reasoning_level TEXT NOT NULL, service_priority TEXT NOT NULL, capacity INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE suplex_agents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL UNIQUE, role TEXT, avatar_seed TEXT NOT NULL, profile_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);");
      const profile = { id: "shared-profile", provider: "codex", model: "gpt-5.6-sol", reasoning_level: "medium", service_priority: "standard", capacity: 2, created_at: "2026-09-02T00:00:00.000Z", updated_at: "2026-09-02T00:00:00.000Z" };
      database.prepare("INSERT INTO suplex_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES (?, 'Shared', ?, ?, ?, ?, ?, ?, ?)").run(profile.id, profile.provider, profile.model, profile.reasoning_level, profile.service_priority, profile.capacity, profile.created_at, profile.updated_at);
      const now = new Date().toISOString();
      database.prepare("INSERT INTO suplex_agents (id, kind, name, role, avatar_seed, profile_id, created_at, updated_at) VALUES ('shared-agent-one', 'internal', 'Shared Agent One', 'planner', 'seed-one', ?, ?, ?), ('shared-agent-two', 'internal', 'Shared Agent Two', 'builder', 'seed-two', ?, ?, ?)").run(profile.id, now, now, profile.id, now, now);

      for (const statement of readFileSync(`${folder}/${migration}`, "utf8").split("--> statement-breakpoint")) {
        if (statement.trim()) database.exec(statement);
      }

      const agents = database.prepare("SELECT a.name, a.profile_id, p.provider, p.model, p.reasoning_level, p.service_priority, p.capacity FROM suplex_agents a JOIN suplex_profiles p ON p.id = a.profile_id WHERE a.id IN ('shared-agent-one', 'shared-agent-two') ORDER BY a.id").all();
      expect(agents).toEqual([
        { name: "Shared Agent One", profile_id: profile.id, provider: profile.provider, model: profile.model, reasoning_level: profile.reasoning_level, service_priority: profile.service_priority, capacity: profile.capacity },
        { name: "Shared Agent Two", profile_id: `${profile.id}-shared-agent-two`, provider: profile.provider, model: profile.model, reasoning_level: profile.reasoning_level, service_priority: profile.service_priority, capacity: profile.capacity },
      ]);
    } finally {
      database.close();
    }
  });

test("qualifies OpenCode model ids and keeps the seeds of an installation with history", () => {
    const folder = resolve(process.cwd(), "drizzle");
    const database = new Database(":memory:", { enableForeignKeyConstraints: false });
    try {
      const migration = readdirSync(folder).find((candidate) => candidate.includes("providers_are_harnesses"))!;
      database.exec("CREATE TABLE suplex_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, provider TEXT NOT NULL, model TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE suplex_tasks (id TEXT PRIMARY KEY);");
      database.exec("INSERT INTO suplex_profiles (id, name, provider, model, updated_at) VALUES ('profile_native_root', 'Root', 'openai', 'gpt-5.6-sol', 'then'), ('profile_native_worker', 'Worker', 'openai', 'gpt-5.6-luna', 'then'), ('profile_local', 'Local', 'claude-code', 'fable', 'then'); INSERT INTO suplex_tasks (id) VALUES ('task-1');");

      for (const statement of readFileSync(`${folder}/${migration}`, "utf8").split("--> statement-breakpoint")) {
        if (statement.trim()) database.exec(statement);
      }

      expect(database.prepare("SELECT id, provider, model, updated_at FROM suplex_profiles ORDER BY id").all()).toEqual([
        { id: "profile_local", provider: "claude-code", model: "fable", updated_at: "then" },
        { id: "profile_native_root", provider: "opencode", model: "openai/gpt-5.6-sol", updated_at: "then" },
        { id: "profile_native_worker", provider: "opencode", model: "openai/gpt-5.6-luna", updated_at: "then" },
      ]);
    } finally {
      database.close();
    }
  });

test("renames the default native agents and keeps a name you chose", () => {
    const folder = resolve(process.cwd(), "drizzle");
    const database = new Database(":memory:", { enableForeignKeyConstraints: false });
    try {
      const migration = readdirSync(folder).find((candidate) => candidate.includes("rename_default_native_agents"))!;
      database.exec("CREATE TABLE suplex_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL); INSERT INTO suplex_profiles (id, name, updated_at) VALUES ('profile_native_root', 'Root', 'then'), ('profile_native_worker', 'Builder', 'then');");

      for (const statement of readFileSync(`${folder}/${migration}`, "utf8").split("--> statement-breakpoint")) {
        if (statement.trim()) database.exec(statement);
      }

      expect(database.prepare("SELECT id, name FROM suplex_profiles ORDER BY id").all()).toEqual([
        { id: "profile_native_root", name: "Smart Coordinator" },
        { id: "profile_native_worker", name: "Builder" },
      ]);
    } finally {
      database.close();
    }
  });

test("backfills nullable projection steps from legacy phases", () => {
    const folder = resolve(process.cwd(), "drizzle");
    const database = new Database(":memory:", { enableForeignKeyConstraints: false });
    try {
      const migration = readdirSync(folder).find((candidate) => candidate.includes("backfill_projection_steps"))!;
      database.exec("CREATE TABLE suplex_issue_projections (phase TEXT, step TEXT)");
      database.exec("INSERT INTO suplex_issue_projections (phase, step) VALUES ('done', NULL), ('development', NULL), ('shipping', 'releasing'), ('delivery_blocked', NULL)");

      for (const statement of readFileSync(`${folder}/${migration}`, "utf8").split("--> statement-breakpoint")) {
        if (statement.trim()) database.exec(statement);
      }

      expect(database.prepare("SELECT phase, step FROM suplex_issue_projections ORDER BY rowid").all()).toEqual([
        { phase: "done", step: "done" },
        { phase: "building", step: "development" },
        { phase: "shipping", step: "releasing" },
        { phase: "delivery_blocked", step: null },
      ]);
    } finally {
      database.close();
    }
  });

test("generalizes external-agent identity without losing pairing, credential, or grant data", () => {
    const folder = resolve(process.cwd(), "drizzle");
    const database = new Database(":memory:", { enableForeignKeyConstraints: false });
    try {
      database.exec(`
        CREATE TABLE suplex_agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar_seed TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE suplex_external_agents (id TEXT PRIMARY KEY, company_id TEXT NOT NULL, hermes_profile_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE UNIQUE INDEX suplex_external_agents_active_profile_unique ON suplex_external_agents (hermes_profile_id) WHERE hermes_profile_id IS NOT NULL AND status != 'revoked';
        CREATE TABLE suplex_hermes_pairing_codes (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, code_hash TEXT NOT NULL, purpose TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, replaced_at TEXT, created_at TEXT NOT NULL);
        CREATE UNIQUE INDEX suplex_hermes_pairing_codes_active_agent_unique ON suplex_hermes_pairing_codes (agent_id) WHERE consumed_at IS NULL AND replaced_at IS NULL;
        CREATE TABLE suplex_external_agent_project_grants (agent_id TEXT NOT NULL, company_id TEXT NOT NULL, project_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (agent_id, project_id));
        CREATE TABLE suplex_external_agent_credentials (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, credential_hash TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
        INSERT INTO suplex_agents VALUES ('agent-1', 'Existing agent', 'seed', 'then', 'then');
        INSERT INTO suplex_external_agents VALUES ('agent-1', 'company-1', 'default', 'paired', 'then', 'then');
        INSERT INTO suplex_hermes_pairing_codes VALUES ('pair-1', 'agent-1', 'pair-hash', 'rotation', 'later', 'then', NULL, 'then');
        INSERT INTO suplex_external_agent_project_grants VALUES ('agent-1', 'company-1', 'project-1', 'then');
        INSERT INTO suplex_external_agent_credentials VALUES ('credential-1', 'agent-1', 'credential-hash', 'then', 'then', NULL);
      `);

      const migration = readdirSync(folder).find((candidate) => candidate.includes("generic_external_agent_identity"))!;
      for (const statement of readFileSync(`${folder}/${migration}`, "utf8").split("--> statement-breakpoint")) {
        if (statement.trim()) database.exec(statement);
      }

      expect(database.prepare("SELECT id, kind FROM suplex_agents").get()).toEqual({ id: "agent-1", kind: "external" });
      expect(database.prepare("SELECT id, client_profile_id, status FROM suplex_external_agents").get()).toEqual({ id: "agent-1", client_profile_id: "default", status: "paired" });
      expect(database.prepare("SELECT id, agent_id, code_hash, consumed_at FROM suplex_external_agent_pairing_codes").get()).toEqual({ id: "pair-1", agent_id: "agent-1", code_hash: "pair-hash", consumed_at: "then" });
      expect(database.prepare("SELECT agent_id, company_id, project_id FROM suplex_external_agent_project_grants").get()).toEqual({ agent_id: "agent-1", company_id: "company-1", project_id: "project-1" });
      expect(database.prepare("SELECT id, agent_id, credential_hash, last_used_at FROM suplex_external_agent_credentials").get()).toEqual({ id: "credential-1", agent_id: "agent-1", credential_hash: "credential-hash", last_used_at: "then" });
      database.prepare("INSERT INTO suplex_agents (id, name, avatar_seed, created_at, updated_at) VALUES ('agent-2', 'Second agent', 'seed-2', 'then', 'then')").run();
      database.prepare("INSERT INTO suplex_external_agents (id, company_id, client_profile_id, status, created_at, updated_at) VALUES ('agent-2', 'company-1', 'default', 'paired', 'then', 'then')").run();
      database.prepare("UPDATE suplex_external_agents SET client_profile_id = NULL WHERE id = 'agent-1'").run();
    } finally {
      database.close();
    }
  });
