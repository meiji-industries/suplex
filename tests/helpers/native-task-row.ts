import type Database from "better-sqlite3";
import { TaskConfigurationSchema } from "../../src/tasks/contracts.js";

export function insertNativeTaskRow(db: Database.Database, options: { taskId?: string; companyId?: string; projectId?: string; directory?: string } = {}): void {
  const taskId = options.taskId ?? "task";
  const companyId = options.companyId ?? "company";
  const stamp = new Date().toISOString();
  db.prepare("INSERT OR IGNORE INTO suplex_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('native-test-user', 'Test', 'native-test-user', 'admin', 'active', ?, ?)").run(stamp, stamp);
  const configuration = TaskConfigurationSchema.parse({ repository: "owner/repo", repositoryPath: options.directory ?? "/repo", worktreeRoot: "/worktrees", branch: "task", baseBranch: "main", baselineSha: "a".repeat(40), startingSha: "a".repeat(40), setupCommand: "", verificationCommand: "", runProjectTests: true, visualEvidence: "off", source: null, capturedAt: stamp });
  db.prepare("INSERT INTO suplex_tasks (id, company_id, project_id, title, description, configuration_json, idempotency_key, request_hash, creator_user_id, created_at, updated_at) VALUES (?, ?, ?, 'Task', 'Task description', ?, ?, ?, 'native-test-user', ?, ?)").run(taskId, companyId, options.projectId ?? "project", JSON.stringify(configuration), `${taskId}-request`, "b".repeat(64), stamp, stamp);
}
