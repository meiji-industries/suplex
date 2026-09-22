import { z } from "zod";
import type Database from "better-sqlite3";
import type { SuplexDatabase } from "../platform/database.js";
import { PullRequestDependencySchema, type PullRequestDependencyInputSchema } from "./contracts.js";

const RowSchema = PullRequestDependencySchema.extend({ taskId: z.string() });
export type PullRequestDependency = z.infer<typeof PullRequestDependencySchema>;
export type PullRequestDependencyInput = z.infer<typeof PullRequestDependencyInputSchema>;

export function pullRequestDependenciesInTransaction(db: Database.Database, taskId: string): PullRequestDependency[] {
  return z.array(RowSchema).parse(db.prepare("SELECT task_id AS taskId, pull_request_number AS number, state, title, url, observed_at AS observedAt FROM suplex_task_pull_request_dependencies WHERE task_id = ? ORDER BY pull_request_number").all(taskId)).map(({ taskId: _taskId, ...dependency }) => dependency);
}

export function pullRequestDependencies(database: SuplexDatabase, taskId: string): PullRequestDependency[] {
  return database.authQuery(db => pullRequestDependenciesInTransaction(db, taskId));
}

export function replacePullRequestDependenciesInTransaction(db: Database.Database, taskId: string, dependencies: PullRequestDependency[]): void {
  db.prepare("DELETE FROM suplex_task_pull_request_dependencies WHERE task_id = ?").run(taskId);
  const insert = db.prepare("INSERT INTO suplex_task_pull_request_dependencies (task_id, pull_request_number, state, title, url, observed_at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const dependency of dependencies) insert.run(taskId, dependency.number, dependency.state, dependency.title, dependency.url, dependency.observedAt);
}

export function updatePullRequestDependencyInTransaction(db: Database.Database, taskId: string, dependency: PullRequestDependency): void {
  db.prepare("UPDATE suplex_task_pull_request_dependencies SET state = ?, title = ?, url = ?, observed_at = ? WHERE task_id = ? AND pull_request_number = ?").run(dependency.state, dependency.title, dependency.url, dependency.observedAt, taskId, dependency.number);
}
