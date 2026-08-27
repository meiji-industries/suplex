import { expect, test } from "vitest";

import { AttentionService } from "../src/attention.js";

test("blocked and awaiting-human turns carry the pane, agent, and excerpt without Forge actions", () => {
  const statements: string[] = [];
  const database = { authQuery(run: (db: { prepare: (sql: string) => { all: () => unknown[]; get: () => unknown } }) => unknown) { return run({ prepare(sql) { statements.push(sql); return { all() { return [{ company_id: "company", issue_key: "FORGE-1", task_id: "task", task_title: "Task", revision: 3, allowed_commands_json: "[]", pending_action: null, activated_at: "2026-08-24T00:00:00.000Z", pane_id: "w1:p2", agent_name: "lead", attention_excerpt: "Which approach should I use?" }]; }, get() { return undefined; } }; } }); } };
  const service = new AttentionService(database as never, { listVisibleCompanies() { return [{ id: "company", name: "Company", status: "active" }]; } } as never);
  expect(service.list("member")[0]).toMatchObject({ attentionCount: 1, attention: [{ summary: "Agent needs you in w1:p2 (lead) Which approach should I use?", actions: [], sourceRevision: 3, card: { title: "Agent is waiting for you", explanation: "Which approach should I use?" } }] });
  expect(statements[0]).toContain("ip.phase NOT IN ('done', 'cancelled') AND rs.is_current = 1");
});
