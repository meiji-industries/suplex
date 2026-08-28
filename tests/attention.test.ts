import { expect, test } from "vitest";

import { AttentionService } from "../src/attention.js";
import { attentionCardFromBlocker } from "../src/recovery/attention-card.js";

test("startup trust and generic prompts produce answerable cards", () => {
  const actions = [{ command: "retry_development", label: "Retry after answering the agent prompt" }];
  expect(attentionCardFromBlocker({ category: "member_authorization", summary: "Do you trust the contents of this directory?" }, { actions })).toMatchObject({ kind: "github_credential", title: "Codex needs this repository trusted", primaryAction: { command: "retry_development", label: "Retry after answering the agent prompt" } });
  expect(attentionCardFromBlocker({ category: "member_authorization", summary: "Choose a startup profile" }, { actions })).toMatchObject({ title: "Agent is waiting at a startup prompt", primaryAction: { command: "retry_development" } });
});

test("blocked and awaiting-human turns carry the pane, agent, and excerpt without Forge actions", () => {
  const statements: string[] = [];
  const database = { authQuery(run: (db: { prepare: (sql: string) => { all: () => unknown[]; get: () => unknown } }) => unknown) { return run({ prepare(sql) { statements.push(sql); return { all() { return [{ company_id: "company", issue_key: "FORGE-1", task_id: "task", task_title: "Task", revision: 3, allowed_commands_json: "[]", pending_action: null, activated_at: "2026-08-24T00:00:00.000Z", pane_id: "w1:p2", agent_name: "lead", attention_excerpt: "Which approach should I use?" }]; }, get() { return undefined; } }; } }); } };
  const service = new AttentionService(database as never, { listVisibleCompanies() { return [{ id: "company", name: "Company", status: "active" }]; } } as never);
  expect(service.list("member")[0]).toMatchObject({ attentionCount: 1, attention: [{ summary: "Agent needs you in w1:p2 (lead) Which approach should I use?", actions: [], sourceRevision: 3, card: { title: "Agent is waiting for you", explanation: "Agent needs you in w1:p2 (lead) Which approach should I use?" } }] });
  expect(statements[0]).toContain("ip.phase NOT IN ('done', 'cancelled') AND rs.is_current = 1");
});

test("provider authentication blockers use the GitHub sign-in card", () => {
  const database = { authQuery(run: (db: { prepare: () => { all: () => unknown[]; get: () => unknown } }) => unknown) { return run({ prepare() { return { all() { return [{ company_id: "company", issue_key: null, task_id: "task", task_title: "Task", revision: 3, allowed_commands_json: "[]", pending_action: "GitHub access needed", activated_at: "2026-08-24T00:00:00.000Z", pane_id: null, agent_name: null, attention_excerpt: null }]; }, get() { return { state_json: JSON.stringify({ blocker: { category: "provider_authentication", summary: "GitHub access needed" } }) }; } }; } }); } };
  const service = new AttentionService(database as never, { listVisibleCompanies() { return [{ id: "company", name: "Company", status: "active" }]; } } as never);
  expect(service.list("member")[0]?.attention[0]?.card.primaryAction.label).toBe("Sign in to GitHub and retry");
});

test("branch checkout blockers explain the duplicate-task recovery choices", () => {
  expect(attentionCardFromBlocker(
    { category: "unsafe_recovery", summary: "feat/time-clock is already checked out by /worktrees/task-owner" },
    { actions: [{ command: "cancel_issue", label: "Cancel issue", destructive: true }, { command: "retry_development", label: "Retry Developer" }] },
  )).toMatchObject({
    title: "Branch is owned by another task",
    explanation: expect.stringContaining("/worktrees/task-owner"),
    primaryAction: { command: "cancel_issue", label: "Cancel this duplicate task", destructive: true },
    secondaryAction: { command: "retry_development", label: "Retry after the other task finishes" },
  });
});

test("repair limit blockers show the delivery decision", () => {
  const actions = [
    { command: "record_delivery_decision", label: "Continue anyway", requiresNote: true },
    { command: "cancel_issue", label: "Cancel issue", destructive: true },
  ];
  expect(attentionCardFromBlocker(
    { category: "agent_exhausted", summary: "The Lead review found one open problem." },
    { actions },
  )).toMatchObject({
    kind: "generic",
    title: "Review problems are not fixed",
    primaryAction: { command: "record_delivery_decision" },
    secondaryAction: { command: "cancel_issue" },
  });
});

test("other repair blockers still show the no-progress card", () => {
  expect(attentionCardFromBlocker(
    { category: "agent_exhausted", summary: "Automatic repair is not making progress." },
    { actions: [{ command: "retry_development", label: "Resume Developer turn" }] },
  )).toMatchObject({ kind: "no_progress", title: "Automatic repair is not making progress" });
});
