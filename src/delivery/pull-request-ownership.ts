import type Database from "better-sqlite3";

import { AuthFailure } from "../identity/auth.js";
import { DeliveryIntentSchema, PullRequestReferenceSchema } from "../tasks/control.js";
import { TaskConfigurationSchema } from "../tasks/contracts.js";

export function hasPullRequestOwner(db: Database.Database, input: { taskId?: string; repository: string; number: number }): boolean {
  const owned = db.prepare(`WITH owner_host(kind) AS (
    SELECT COALESCE((SELECT json_extract(configuration_json, '$.integration.repository.kind') FROM forge_tasks WHERE id = ?), 'github')
  ), known(id, name) AS (SELECT repository_id, repository_name FROM forge_github_trigger_rules UNION SELECT repository_id, repository_name FROM forge_github_trigger_dispatches),
  names(name) AS (SELECT lower(?) UNION SELECT lower(name) FROM known WHERE (SELECT kind FROM owner_host) = 'github' AND id IN (SELECT id FROM known WHERE lower(name) = lower(?)))
  SELECT 1 FROM forge_tasks t JOIN forge_task_controls c ON c.task_id = t.id
  WHERE (? IS NULL OR t.id <> ?) AND t.archived_at IS NULL AND c.status IN ('backlog','queued','active','waiting_human')
    AND COALESCE(json_extract(t.configuration_json, '$.integration.repository.kind'), 'github') = (SELECT kind FROM owner_host)
    AND ((lower(json_extract(t.configuration_json, '$.repository')) IN (SELECT name FROM names) AND json_extract(t.configuration_json, '$.source.kind') = 'pull_request' AND json_extract(t.configuration_json, '$.source.number') = ?)
      OR (lower(json_extract(c.delivery_intent_json, '$.repository')) IN (SELECT name FROM names) AND json_extract(c.delivery_intent_json, '$.pullRequestNumber') = ?)
      OR (lower(json_extract(c.pull_request_json, '$.repository')) IN (SELECT name FROM names) AND json_extract(c.pull_request_json, '$.number') = ?)) LIMIT 1`).get(input.taskId ?? null, input.repository, input.repository, input.taskId ?? null, input.taskId ?? null, input.number, input.number, input.number);
  return Boolean(owned);
}

export function assertPullRequestAvailable(db: Database.Database, input: { taskId: string; repository: string; number: number }): void {
  if (hasPullRequestOwner(db, input)) throw new AuthFailure("A task already uses this pull request.", 409);
}

export function assertTaskPullRequestsAvailable(db: Database.Database, taskId: string): void {
  const row = db.prepare("SELECT t.configuration_json, c.delivery_intent_json, c.pull_request_json FROM forge_tasks t JOIN forge_task_controls c ON c.task_id = t.id WHERE t.id = ?").get(taskId) as { configuration_json: string; delivery_intent_json: string; pull_request_json: string | null } | undefined;
  if (!row) return;
  const configuration = TaskConfigurationSchema.parse(JSON.parse(row.configuration_json));
  const intent = DeliveryIntentSchema.parse(JSON.parse(row.delivery_intent_json));
  const pull = row.pull_request_json ? PullRequestReferenceSchema.parse(JSON.parse(row.pull_request_json)) : null;
  const values = [configuration.source?.kind === "pull_request" ? { repository: configuration.repository, number: configuration.source.number } : null, intent.pullRequestNumber === null ? null : { repository: intent.repository, number: intent.pullRequestNumber }, pull && { repository: pull.repository, number: pull.number }].filter((value): value is { repository: string; number: number } => value !== null);
  for (const value of values) assertPullRequestAvailable(db, { taskId, ...value });
}
