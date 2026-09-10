import { z } from "zod";
import type { ForgeDatabase } from "../platform/database.js";
import { DeliveryIntentSchema, PullRequestReferenceSchema } from "../tasks/control.js";
import { createGithubReleasePort } from "../integrations/github/delivery.js";
import type { GithubReleaseAdapter } from "../integrations/github/delivery.js";

const Candidate = z.object({ taskId: z.string(), pullJson: z.string().nullable(), intentJson: z.string() }).transform(row => {
  const pull = row.pullJson === null ? null : PullRequestReferenceSchema.parse(JSON.parse(row.pullJson));
  const intent = DeliveryIntentSchema.parse(JSON.parse(row.intentJson));
  return { ...row, pull, repository: pull?.repository ?? intent.repository, number: pull?.number ?? intent.pullRequestNumber };
});
type Github = Required<Pick<GithubReleaseAdapter, "getPullRequestStates">>;

export class CompletedPullRequests {
  private running: Promise<void> | undefined;

  constructor(private readonly database: ForgeDatabase, private readonly github: Github = createGithubReleasePort()) {}

  refresh(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.observe().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async observe(): Promise<void> {
    const candidates = this.database.authQuery(db => z.array(Candidate).parse(db.prepare(`
      SELECT c.task_id AS taskId, c.pull_request_json AS pullJson, c.delivery_intent_json AS intentJson
      FROM forge_task_controls c JOIN forge_tasks t ON t.id = c.task_id
      WHERE c.status = 'delivered' AND t.archived_at IS NULL
        AND (json_extract(c.pull_request_json, '$.state') != 'merged'
          OR (c.pull_request_json IS NULL AND json_extract(c.delivery_intent_json, '$.pullRequestNumber') IS NOT NULL))
    `).all()));
    if (!candidates.length) return;
    const observed = await this.github.getPullRequestStates(candidates.flatMap(candidate => candidate.number === null ? [] : [{ repository: candidate.repository, number: candidate.number }]));
    const byIdentity = new Map(observed.map(pull => [`${pull.repository.toLowerCase()}#${pull.number}`, pull]));
    this.database.authImmediateTransaction(db => {
      const update = db.prepare(`UPDATE forge_task_controls SET pull_request_json = ?, updated_at = ?
        WHERE task_id = ? AND status = 'delivered' AND pull_request_json IS ?
          AND EXISTS (SELECT 1 FROM forge_tasks WHERE id = task_id AND archived_at IS NULL)`);
      for (const candidate of candidates) {
        const pull = byIdentity.get(`${candidate.repository.toLowerCase()}#${candidate.number}`);
        if (!pull || JSON.stringify(pull) === JSON.stringify(candidate.pull)) continue;
        update.run(JSON.stringify(pull), new Date().toISOString(), candidate.taskId, candidate.pullJson);
      }
    });
  }
}
