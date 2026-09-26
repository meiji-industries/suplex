import { readFile } from "node:fs/promises";
import { DatabaseSync as Database } from "node:sqlite";
import { expect, test } from "vitest";

test("default profile allowlist repair adds each project's own defaults without disturbing the rest", async () => {
  const database = new Database(":memory:", { enableForeignKeyConstraints: false });
  try {
    database.exec("CREATE TABLE suplex_projects (id TEXT PRIMARY KEY, root_profile_id TEXT, worker_profile_id TEXT, agent_task_policy_json TEXT)");
    const insert = database.prepare("INSERT INTO suplex_projects VALUES (?, ?, ?, ?)");
    const policy = (root: string[], worker: string[]) => JSON.stringify({ workflowIds: ["workflow_native_standard"], defaultWorkflowId: "workflow_native_standard", templateIds: [], rootProfileIds: root, workerProfileIds: worker, advisorProfileIds: {}, deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off" });
    insert.run("drifted", "profile_new_root", "profile_new_worker", policy(["profile_old_root"], ["profile_old_worker"]));
    insert.run("current", "profile_native_root", "profile_native_worker", policy(["profile_native_root"], ["profile_native_worker"]));
    insert.run("unpoliced", "profile_native_root", "profile_native_worker", "{}");

    const migration = await readFile(new URL("../migrations/20260910180000000_repair_project_default_profile_allowlists.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) database.exec(statement);

    const read = (id: string) => JSON.parse((database.prepare("SELECT agent_task_policy_json AS policy FROM suplex_projects WHERE id = ?").get(id) as { policy: string }).policy);
    expect(read("drifted")).toMatchObject({ rootProfileIds: ["profile_old_root", "profile_new_root"], workerProfileIds: ["profile_old_worker", "profile_new_worker"], defaultWorkflowId: "workflow_native_standard" });
    expect(read("current")).toMatchObject({ rootProfileIds: ["profile_native_root"], workerProfileIds: ["profile_native_worker"] });
    expect(read("unpoliced")).toEqual({});
  } finally { database.close(); }
});
