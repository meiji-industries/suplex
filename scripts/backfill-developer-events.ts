import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { resolveAgentProvider } from "../src/agent-providers/index.js";
import { ForgeDatabase } from "../src/database.js";

type Execution = { id: string; attempt: number; worktreePath: string };

const root = process.cwd();
const database = new ForgeDatabase(join(root, ".forge", "data", "forge.sqlite"), { migrate: false });
const provider = resolveAgentProvider();
const requestedIds = process.argv.slice(2);

function persist(execution: Execution, receipts: ReturnType<typeof provider.parseExecutionTranscript>["receipts"]): number {
  if (!receipts.length) return 0;
  database.authTransaction((db) => {
    for (const receipt of receipts) {
      db.prepare("INSERT OR IGNORE INTO forge_developer_execution_events (event_id, execution_id, attempt, sequence, kind, step_number, source_item_id, occurred_at, summary, exit_code, artifact_id, artifact_sha256, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(receipt.eventId, execution.id, receipt.attempt, receipt.sequence, receipt.kind, receipt.stepNumber, receipt.sourceItemId, receipt.occurredAt, receipt.summary, receipt.exitCode, receipt.artifactId, receipt.artifactSha256, receipt.idempotencyKey);
    }
    db.prepare("UPDATE forge_developer_executions SET heartbeat_at = ? WHERE id = ?").run(new Date().toISOString(), execution.id);
  });
  return receipts.length;
}

try {
  const executions = database.authQuery((db) => db.prepare(`
    SELECT e.id, e.attempt, e.worktree_path AS worktreePath
    FROM forge_developer_executions e
    WHERE ${requestedIds.length ? `e.id IN (${requestedIds.map(() => "?").join(", ")})` : "1 = 1"}
      AND NOT EXISTS (SELECT 1 FROM forge_developer_execution_events event WHERE event.execution_id = e.id)
    ORDER BY e.started_at DESC
  `).all(...requestedIds) as Execution[]);
  for (const execution of executions) {
    const eventsPath = resolve(root, ".forge", "data", "runtime", "developer-executions", execution.id, "events.jsonl");
    const lines = (await readFile(eventsPath, "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean);
    if (!lines.length) {
      console.log(`${execution.id}: skipped (events.jsonl missing or empty)`);
      continue;
    }
    const parsed = provider.parseExecutionTranscript(lines, { executionId: execution.id, attempt: execution.attempt, worktreePath: execution.worktreePath });
    const count = persist(execution, parsed.receipts);
    console.log(`${execution.id}: ${count} receipts from ${lines.length} JSONL lines`);
  }
} finally {
  database.close();
}
