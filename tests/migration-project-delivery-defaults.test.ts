import { readFile } from "node:fs/promises";
import { DatabaseSync as Database } from "node:sqlite";
import { expect, test } from "vitest";

test("project delivery defaults keep each project's stored values and remove the agent task policy", async () => {
  const database = new Database(":memory:", { enableForeignKeyConstraints: false });
  try {
    database.exec("CREATE TABLE suplex_projects (id TEXT PRIMARY KEY, company_id TEXT NOT NULL, root_profile_id TEXT, worker_profile_id TEXT, agent_task_policy_json text NOT NULL DEFAULT '{}')");
    database.exec("CREATE INDEX suplex_projects_company_idx ON suplex_projects (company_id)");
    const insert = database.prepare("INSERT INTO suplex_projects (id, company_id, root_profile_id, worker_profile_id, agent_task_policy_json) VALUES (?, 'company', 'profile_native_root', 'profile_native_worker', ?)");
    const policy = (delivery: object) => JSON.stringify({ workflowIds: ["workflow_native_standard"], defaultWorkflowId: "workflow_native_standard", templateIds: [], rootProfileIds: ["profile_native_root"], workerProfileIds: ["profile_native_worker"], advisorProfileIds: { reviewer: [], planner_a: [], planner_b: [], rater: [] }, ...delivery });
    insert.run("custom", policy({ deliveryTarget: "merged", runProjectTests: false, visualEvidence: "required" }));
    insert.run("local", policy({ deliveryTarget: "local_worktree", runProjectTests: true, visualEvidence: "capture" }));
    insert.run("seeded", policy({ deliveryTarget: "pull_request_draft", runProjectTests: 1, visualEvidence: "off" }));
    insert.run("partial", policy({ deliveryTarget: "remote_branch" }));
    insert.run("legacy", "{}");

    const migration = await readFile(new URL("../apps/server/migrations/20261008012902080_project_delivery_defaults.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) database.exec(statement);

    const rows = database.prepare("SELECT id, delivery_target AS deliveryTarget, run_project_tests AS runProjectTests, visual_evidence AS visualEvidence FROM suplex_projects ORDER BY id").all();
    expect(rows.map(row => ({ ...row }))).toEqual([
      { id: "custom", deliveryTarget: "merged", runProjectTests: 0, visualEvidence: "required" },
      { id: "legacy", deliveryTarget: "pull_request_draft", runProjectTests: 1, visualEvidence: "off" },
      { id: "local", deliveryTarget: "local_worktree", runProjectTests: 1, visualEvidence: "capture" },
      { id: "partial", deliveryTarget: "remote_branch", runProjectTests: 1, visualEvidence: "off" },
      { id: "seeded", deliveryTarget: "pull_request_draft", runProjectTests: 1, visualEvidence: "off" },
    ]);
    const columns = database.prepare("SELECT name FROM pragma_table_info('suplex_projects')").all().map(row => row.name);
    expect(columns).toEqual(["id", "company_id", "root_profile_id", "worker_profile_id", "delivery_target", "run_project_tests", "visual_evidence"]);
    expect(columns.some(name => String(name).includes("policy"))).toBe(false);
  } finally { database.close(); }
});
