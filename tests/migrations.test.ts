import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { applyMigrations, readMigrations } from "../src/database.js";

describe("timestamp migrations", () => {
  test("recognizes migrations applied by the legacy Drizzle journal runner", () => {
    const folder = mkdtempSync(join(tmpdir(), "forge-migrations-"));
    const database = new Database(":memory:");
    try {
      const sql = "CREATE TABLE existing (id text PRIMARY KEY);\n";
      writeFileSync(join(folder, "20260812120000000_create_existing.sql"), sql);
      const [migration] = readMigrations(folder);
      database.exec("CREATE TABLE existing (id text PRIMARY KEY); CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)");
      database.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(migration!.hash, migration!.createdAt);

      expect(() => applyMigrations(database, folder)).not.toThrow();
      expect(database.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get()).toEqual({ count: 1 });
    } finally {
      database.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("applies a missing older migration after a newer migration", () => {
    const folder = mkdtempSync(join(tmpdir(), "forge-migrations-"));
    const database = new Database(":memory:");
    try {
      writeFileSync(join(folder, "20260812120000000_create_newer.sql"), "CREATE TABLE newer (id text PRIMARY KEY);\n");
      applyMigrations(database, folder);

      writeFileSync(join(folder, "20260812110000000_create_older.sql"), "CREATE TABLE older (id text PRIMARY KEY);\n");
      applyMigrations(database, folder);

      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('older', 'newer') ORDER BY name").all();
      expect(tables).toEqual([{ name: "newer" }, { name: "older" }]);
      expect(database.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get()).toEqual({ count: 2 });
    } finally {
      database.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("rejects sequential and duplicate timestamp names", () => {
    const folder = mkdtempSync(join(tmpdir(), "forge-migrations-"));
    try {
      writeFileSync(join(folder, "0022_sequential.sql"), "SELECT 1;\n");
      expect(() => readMigrations(folder)).toThrow("must start with a UTC timestamp");
      rmSync(join(folder, "0022_sequential.sql"));
      writeFileSync(join(folder, "20260812120000_one.sql"), "SELECT 1;\n");
      writeFileSync(join(folder, "20260812120000_two.sql"), "SELECT 2;\n");
      expect(() => readMigrations(folder)).toThrow("timestamps must be unique");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("applies full chain on an empty database and validates constraints", () => {
    const folder = resolve(process.cwd(), "drizzle");
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    try {
      applyMigrations(database, folder);

      expect(database.prepare("PRAGMA index_list('forge_issue_timeline')").all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "forge_issue_timeline_task_idx" }),
      ]));
      expect(database.prepare("PRAGMA foreign_key_list('forge_developer_result_conflicts')").all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ from: "existing_delivery_artifact_id", table: "forge_artifacts" }),
        expect.objectContaining({ from: "existing_evidence_artifact_id", table: "forge_artifacts" }),
        expect.objectContaining({ from: "conflicting_delivery_artifact_id", table: "forge_artifacts" }),
        expect.objectContaining({ from: "conflicting_evidence_artifact_id", table: "forge_artifacts" }),
      ]));
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);

      // Verify internal agent constraint check
      const profile = database.prepare("SELECT id FROM forge_profiles LIMIT 1").get() as { id: string };
      expect(profile).toBeDefined();

      const now = new Date().toISOString();
      // Valid internal agent
      database.prepare("INSERT INTO forge_agents (id, kind, name, role, avatar_seed, profile_id, created_at, updated_at) VALUES ('agent_int_1', 'internal', 'Planner 1', 'planner', 'seed1', ?, ?, ?)").run(profile.id, now, now);

      // Invalid internal agent (missing profile)
      expect(() => {
        database.prepare("INSERT INTO forge_agents (id, kind, name, role, avatar_seed, profile_id, created_at, updated_at) VALUES ('agent_bad_1', 'internal', 'Bad 1', 'planner', 'seed2', NULL, ?, ?)").run(now, now);
      }).toThrow(/CHECK constraint/i);

      // Invalid internal agent (invalid role)
      expect(() => {
        database.prepare("INSERT INTO forge_agents (id, kind, name, role, avatar_seed, profile_id, created_at, updated_at) VALUES ('agent_bad_2', 'internal', 'Bad 2', 'invalid', 'seed2', ?, ?, ?)").run(profile.id, now, now);
      }).toThrow(/CHECK constraint/i);

      // Valid hermes agent
      database.prepare("INSERT INTO forge_agents (id, kind, name, role, avatar_seed, profile_id, created_at, updated_at) VALUES ('agent_herm_1', 'hermes', 'Hermes 1', NULL, 'seed3', NULL, ?, ?)").run(now, now);

      // Invalid hermes agent (has role or profile)
      expect(() => {
        database.prepare("INSERT INTO forge_agents (id, kind, name, role, avatar_seed, profile_id, created_at, updated_at) VALUES ('agent_bad_3', 'hermes', 'Bad 3', 'planner', 'seed4', NULL, ?, ?)").run(now, now);
      }).toThrow(/CHECK constraint/i);
      expect(() => {
        database.prepare("INSERT INTO forge_agents (id, kind, name, role, avatar_seed, profile_id, created_at, updated_at) VALUES ('agent_bad_4', 'hermes', 'Bad 4', NULL, 'seed4', ?, ?, ?)").run(profile.id, now, now);
      }).toThrow(/CHECK constraint/i);

      // Audit event constraints: cannot have both actor_user_id and actor_agent_id
      const user = database.prepare("SELECT id FROM forge_users LIMIT 1").get() as { id: string } | undefined;
      const userId = user?.id ?? "user_test_1";
      if (!user) {
        database.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES (?, 'Test', 'test', 'admin', 'active', ?, ?, 1)").run(userId, now, now);
      }

      // Valid: only actor_user_id
      database.prepare("INSERT INTO forge_audit_events (id, actor_user_id, actor_agent_id, action, metadata_json, created_at) VALUES ('audit_1', ?, NULL, 'test_user_action', '{}', ?)").run(userId, now);
      // Valid: only actor_agent_id
      database.prepare("INSERT INTO forge_audit_events (id, actor_user_id, actor_agent_id, action, metadata_json, created_at) VALUES ('audit_2', NULL, 'agent_herm_1', 'test_agent_action', '{}', ?)").run(now);
      // Valid: system event (neither)
      database.prepare("INSERT INTO forge_audit_events (id, actor_user_id, actor_agent_id, action, metadata_json, created_at) VALUES ('audit_3', NULL, NULL, 'test_system_action', '{}', ?)").run(now);
      // Invalid: both actor_user_id and actor_agent_id
      expect(() => {
        database.prepare("INSERT INTO forge_audit_events (id, actor_user_id, actor_agent_id, action, metadata_json, created_at) VALUES ('audit_bad', ?, 'agent_herm_1', 'test_bad_action', '{}', ?)").run(userId, now);
      }).toThrow(/CHECK constraint/i);

      // Invalid: foreign key on missing actor_agent_id
      expect(() => {
        database.prepare("INSERT INTO forge_audit_events (id, actor_user_id, actor_agent_id, action, metadata_json, created_at) VALUES ('audit_bad_fk', NULL, 'non_existent_agent', 'test_action', '{}', ?)").run(now);
      }).toThrow(/FOREIGN KEY/i);
    } finally {
      database.close();
    }
  });

  test("migrates pre-correction database containing internal and Hermes data", () => {
    const folder = resolve(process.cwd(), "drizzle");
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    try {
      const allMigrations = readMigrations(folder);
      const correctiveMigration = allMigrations.find((m) => m.tag.includes("hermes_unified_agent_identity_and_attribution"))!;
      const preCorrectionMigrations = allMigrations.filter((m) => m.createdAt < correctiveMigration.createdAt);

      // Apply migrations up to pre-correction
      database.exec(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
      )`);
      const insert = database.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)");
      database.transaction(() => {
        for (const m of preCorrectionMigrations) {
          const rawSql = readFileSync(`${folder}/${m.tag}.sql`, "utf8");
          for (const statement of rawSql.split("--> statement-breakpoint")) {
            if (statement.trim()) database.exec(statement);
          }
          insert.run(m.hash, m.createdAt);
        }
      })();

      const now = new Date().toISOString();
      // Setup company and profile
      database.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('comp_1', 'Company 1', 'active', ?)").run(now);
      database.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project_1', 'comp_1', 'Project 1', '/repo', '/worktrees', 'acme/project', 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(now, now);
      const profile = database.prepare("SELECT id FROM forge_profiles LIMIT 1").get() as { id: string };

      // Pre-correction internal agent
      database.prepare("INSERT INTO forge_agents (id, name, role, avatar_seed, profile_id, created_at, updated_at) VALUES ('agent_internal_old', 'Shared Legacy Name', 'analyst', 'seed_int', ?, ?, ?)").run(profile.id, now, now);

      // Pre-correction hermes agent (in old forge_external_agents shape)
      database.prepare("INSERT INTO forge_external_agents (id, name, avatar_seed, company_id, hermes_profile_id, status, paired_at, created_at, updated_at) VALUES ('agent_hermes_paired', 'Shared Legacy Name', 'seed_paired', 'comp_1', 'profile_paired', 'paired', ?, ?, ?)").run(now, now, now);
      database.prepare("INSERT INTO forge_external_agents (id, name, avatar_seed, company_id, hermes_profile_id, status, revoked_at, created_at, updated_at) VALUES ('agent_hermes_revoked', 'Old Revoked Hermes', 'seed_revoked', 'comp_1', 'profile_revoked', 'revoked', ?, ?, ?)").run(now, now, now);
      database.prepare("INSERT INTO forge_external_agents (id, name, avatar_seed, company_id, status, created_at, updated_at) VALUES ('agent_hermes_pending', 'Old Pending Hermes', 'seed_pending', 'comp_1', 'pending', ?, ?)").run(now, now);
      database.prepare("INSERT INTO forge_external_agent_project_grants (agent_id, company_id, project_id, created_at) VALUES ('agent_hermes_paired', 'comp_1', 'project_1', ?), ('agent_hermes_pending', 'comp_1', 'project_1', ?)").run(now, now);
      database.prepare("INSERT INTO forge_hermes_pairing_codes (id, agent_id, code_hash, purpose, expires_at, created_at) VALUES ('pairing-active', 'agent_hermes_pending', 'hash-active', 'initial', '2099-01-01T00:00:00.000Z', ?), ('pairing-consumed', 'agent_hermes_paired', 'hash-consumed', 'initial', '2099-01-01T00:00:00.000Z', ?)").run(now, now);
      database.prepare("UPDATE forge_hermes_pairing_codes SET consumed_at = ?, replaced_at = ? WHERE id = 'pairing-consumed'").run("2026-08-14T12:00:00.000Z", "2026-08-14T12:01:00.000Z");
      database.prepare("INSERT INTO forge_hermes_pairing_codes (id, agent_id, code_hash, purpose, expires_at, created_at) VALUES ('pairing-rotation', 'agent_hermes_paired', 'hash-rotation', 'rotation', '2099-01-01T00:00:00.000Z', ?)").run(now);
      database.prepare("INSERT INTO forge_external_agent_credentials (id, agent_id, credential_hash, created_at, last_used_at) VALUES ('credential-active', 'agent_hermes_paired', 'credential-hash-active', ?, ?)").run(now, "2026-08-14T12:02:00.000Z");
      database.prepare("INSERT INTO forge_external_agent_credentials (id, agent_id, credential_hash, created_at, revoked_at) VALUES ('credential-revoked', 'agent_hermes_revoked', 'credential-hash-revoked', ?, ?)").run(now, "2026-08-14T12:03:00.000Z");

      // Apply the corrective migration
      const rawSql = readFileSync(`${folder}/${correctiveMigration.tag}.sql`, "utf8");
      database.transaction(() => {
        for (const statement of rawSql.split("--> statement-breakpoint")) {
          if (statement.trim()) database.exec(statement);
        }
        insert.run(correctiveMigration.hash, correctiveMigration.createdAt);
      })();

      // Verify internal agent preserved
      const internalAgent = database.prepare("SELECT * FROM forge_agents WHERE id = 'agent_internal_old'").get() as {
        id: string; kind: string; name: string; role: string; avatar_seed: string; profile_id: string;
      };
      expect(internalAgent).toMatchObject({
        id: "agent_internal_old",
        kind: "internal",
        name: "Shared Legacy Name",
        role: "analyst",
        avatar_seed: "seed_int",
        profile_id: profile.id,
      });

      // Verify paired hermes agent backfilled into forge_agents and preserved in forge_external_agents
      const hermesBase = database.prepare("SELECT * FROM forge_agents WHERE id = 'agent_hermes_paired'").get() as {
        id: string; kind: string; name: string; role: string | null; avatar_seed: string; profile_id: string | null;
      };
      expect(hermesBase).toMatchObject({
        id: "agent_hermes_paired",
        kind: "hermes",
        name: "Shared Legacy Name",
        role: null,
        avatar_seed: "seed_paired",
        profile_id: null,
      });

      const hermesExt = database.prepare("SELECT * FROM forge_external_agents WHERE id = 'agent_hermes_paired'").get() as {
        id: string; company_id: string; hermes_profile_id: string; status: string;
      };
      expect(hermesExt).toMatchObject({
        id: "agent_hermes_paired",
        company_id: "comp_1",
        hermes_profile_id: "profile_paired",
        status: "paired",
      });

      // Verify revoked hermes agent
      const revokedBase = database.prepare("SELECT * FROM forge_agents WHERE id = 'agent_hermes_revoked'").get() as {
        id: string; kind: string; name: string;
      };
      expect(revokedBase).toMatchObject({
        id: "agent_hermes_revoked",
        kind: "hermes",
        name: "Old Revoked Hermes",
      });
      expect(database.prepare("SELECT id, kind, name, avatar_seed, created_at, updated_at FROM forge_agents WHERE id IN ('agent_internal_old', 'agent_hermes_paired') ORDER BY id").all()).toEqual([
        { id: "agent_hermes_paired", kind: "hermes", name: "Shared Legacy Name", avatar_seed: "seed_paired", created_at: now, updated_at: now },
        { id: "agent_internal_old", kind: "internal", name: "Shared Legacy Name", avatar_seed: "seed_int", created_at: now, updated_at: now },
      ]);
      expect(() => database.prepare("INSERT INTO forge_agents (id, kind, name, role, avatar_seed, profile_id, created_at, updated_at) VALUES ('agent_internal_duplicate', 'internal', 'Shared Legacy Name', 'analyst', 'seed_duplicate', ?, ?, ?)").run(profile.id, now, now)).toThrow(/UNIQUE constraint/i);
      expect(() => database.prepare("INSERT INTO forge_agents (id, kind, name, role, avatar_seed, profile_id, created_at, updated_at) VALUES ('agent_hermes_duplicate', 'hermes', 'Shared Legacy Name', NULL, 'seed_duplicate', NULL, ?, ?)").run(now, now)).toThrow(/UNIQUE constraint/i);
      expect(database.prepare("SELECT COUNT(*) AS count FROM forge_external_agents").get()).toEqual({ count: 3 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM forge_external_agent_project_grants").get()).toEqual({ count: 2 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM forge_hermes_pairing_codes").get()).toEqual({ count: 3 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM forge_external_agent_credentials").get()).toEqual({ count: 2 });
      expect(database.prepare("SELECT id, code_hash, consumed_at, replaced_at FROM forge_hermes_pairing_codes ORDER BY id").all()).toEqual([
        { id: "pairing-active", code_hash: "hash-active", consumed_at: null, replaced_at: null },
        { id: "pairing-consumed", code_hash: "hash-consumed", consumed_at: "2026-08-14T12:00:00.000Z", replaced_at: "2026-08-14T12:01:00.000Z" },
        { id: "pairing-rotation", code_hash: "hash-rotation", consumed_at: null, replaced_at: null },
      ]);
      expect(database.prepare("SELECT id, credential_hash, last_used_at, revoked_at FROM forge_external_agent_credentials ORDER BY id").all()).toEqual([
        { id: "credential-active", credential_hash: "credential-hash-active", last_used_at: "2026-08-14T12:02:00.000Z", revoked_at: null },
        { id: "credential-revoked", credential_hash: "credential-hash-revoked", last_used_at: null, revoked_at: "2026-08-14T12:03:00.000Z" },
      ]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() => database.prepare("INSERT INTO forge_external_agent_credentials (id, agent_id, credential_hash, created_at) VALUES ('credential-second-active', 'agent_hermes_paired', 'credential-hash-second', ?)").run(now)).toThrow();
      expect(() => database.prepare("INSERT INTO forge_hermes_pairing_codes (id, agent_id, code_hash, purpose, expires_at, created_at) VALUES ('pairing-second-active', 'agent_hermes_pending', 'hash-second', 'initial', '2099-01-01T00:00:00.000Z', ?)").run(now)).toThrow();
      database.prepare("INSERT INTO forge_audit_events (id, actor_agent_id, action, metadata_json, created_at) VALUES ('audit-valid-agent', 'agent_hermes_paired', 'test', '{}', ?)").run(now);
      expect(() => database.prepare("INSERT INTO forge_audit_events (id, actor_agent_id, action, metadata_json, created_at) VALUES ('audit-invalid-agent', 'missing-agent', 'test', '{}', ?)").run(now)).toThrow();
    } finally {
      database.close();
    }
  });

  test("rolls back a legacy internal and Hermes ID collision", () => {
    const folder = resolve(process.cwd(), "drizzle");
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    try {
      const allMigrations = readMigrations(folder);
      const correctiveMigration = allMigrations.find((migration) => migration.tag.includes("hermes_unified_agent_identity_and_attribution"))!;
      const preCorrectionMigrations = allMigrations.filter((migration) => migration.createdAt < correctiveMigration.createdAt);
      database.exec("CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)");
      const insert = database.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)");
      database.transaction(() => {
        for (const migration of preCorrectionMigrations) {
          for (const statement of readFileSync(`${folder}/${migration.tag}.sql`, "utf8").split("--> statement-breakpoint")) {
            if (statement.trim()) database.exec(statement);
          }
          insert.run(migration.hash, migration.createdAt);
        }
      })();

      const now = new Date().toISOString();
      const profile = database.prepare("SELECT id FROM forge_profiles LIMIT 1").get() as { id: string };
      database.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('comp_collision', 'Collision Co', 'active', ?)").run(now);
      database.prepare("INSERT INTO forge_agents (id, name, role, avatar_seed, profile_id, created_at, updated_at) VALUES ('agent_collision', 'Internal Collision', 'analyst', 'seed_internal', ?, ?, ?)").run(profile.id, now, now);
      database.prepare("INSERT INTO forge_external_agents (id, name, avatar_seed, company_id, status, created_at, updated_at) VALUES ('agent_collision', 'Hermes Collision', 'seed_hermes', 'comp_collision', 'pending', ?, ?)").run(now, now);
      database.prepare("INSERT INTO forge_hermes_pairing_codes (id, agent_id, code_hash, purpose, expires_at, created_at) VALUES ('pairing_collision', 'agent_collision', 'collision-hash', 'initial', '2099-01-01T00:00:00.000Z', ?)").run(now);

      const correctiveSql = readFileSync(`${folder}/${correctiveMigration.tag}.sql`, "utf8");
      expect(() => database.transaction(() => {
        for (const statement of correctiveSql.split("--> statement-breakpoint")) {
          if (statement.trim()) database.exec(statement);
        }
        insert.run(correctiveMigration.hash, correctiveMigration.createdAt);
      })()).toThrow(/UNIQUE|PRIMARY KEY/i);

      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('forge_agents', 'forge_external_agents', 'forge_hermes_pairing_codes') ORDER BY name").all()).toEqual([
        { name: "forge_agents" },
        { name: "forge_external_agents" },
        { name: "forge_hermes_pairing_codes" },
      ]);
      expect(database.prepare("SELECT id, name, avatar_seed, profile_id, created_at, updated_at FROM forge_agents WHERE id = 'agent_collision'").get()).toEqual({ id: "agent_collision", name: "Internal Collision", avatar_seed: "seed_internal", profile_id: profile.id, created_at: now, updated_at: now });
      expect(database.prepare("SELECT id, name, avatar_seed, company_id, created_at, updated_at FROM forge_external_agents WHERE id = 'agent_collision'").get()).toEqual({ id: "agent_collision", name: "Hermes Collision", avatar_seed: "seed_hermes", company_id: "comp_collision", created_at: now, updated_at: now });
      expect(database.prepare("SELECT id, agent_id, code_hash, purpose, expires_at, created_at FROM forge_hermes_pairing_codes WHERE id = 'pairing_collision'").get()).toEqual({ id: "pairing_collision", agent_id: "agent_collision", code_hash: "collision-hash", purpose: "initial", expires_at: "2099-01-01T00:00:00.000Z", created_at: now });
      expect(database.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations WHERE hash = ? OR created_at = ?").get(correctiveMigration.hash, correctiveMigration.createdAt)).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
