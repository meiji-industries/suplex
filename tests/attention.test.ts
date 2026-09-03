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
  expect(service.list("member")[0]?.attention[0]?.card.primaryAction.label).toBe("Check CI");
});

test("branch checkout blockers explain the duplicate-task recovery choices", () => {
  expect(attentionCardFromBlocker(
    { category: "unsafe_recovery", summary: "feat/time-clock is already checked out by /worktrees/task-owner" },
    { actions: [{ command: "cancel_issue", label: "Cancel the task", destructive: true }, { command: "retry_development", label: "Retry Developer" }] },
  )).toMatchObject({
    title: "Another task owns this branch",
    explanation: expect.stringContaining("/worktrees/task-owner"),
    primaryAction: { command: "cancel_issue", label: "Cancel this duplicate task", destructive: true },
    secondaryAction: { command: "retry_development", label: "Retry when the other task is complete" },
  });
});

test("delivery arbitration acceptance shows publication and cancellation", () => {
  expect(attentionCardFromBlocker(
    { category: "member_authorization", summary: "Accept the delivery because the finding is advisory." },
    { step: "delivery_reviewed", actions: [{ command: "publish_draft", label: "Publish the pull request" }, { command: "cancel_issue", label: "Cancel the task", destructive: true }] },
  )).toMatchObject({
    kind: "generic",
    title: "The Planner recommends that you accept the delivery as is",
    primaryAction: { command: "publish_draft", label: "Publish the pull request" },
    secondaryAction: { command: "cancel_issue", label: "Cancel the task", destructive: true },
  });
});

test("other repair blockers still show the no-progress card", () => {
  expect(attentionCardFromBlocker(
    { category: "agent_exhausted", summary: "Automatic repair is not making progress." },
    { actions: [{ command: "retry_development", label: "Resume the Builder turn" }] },
  )).toMatchObject({ kind: "no_progress", title: "Automatic repair does not make progress" });
});

test("verification blockers use a stable title and pending actions end on a word", () => {
  expect(attentionCardFromBlocker(
    { code: "verification_failed", summary: "pnpm test did not complete successfully.\nFailures:\nFAIL unit tests/company-clear.test.ts\nOutput tail:\nSqliteError" },
    { pendingAction: "Review the verification result and decide whether the task can continue after the base branch fails." },
  )).toMatchObject({
    title: "Verification failed after the base merge",
    evidence: expect.arrayContaining([{ kind: "text", ref: "Failures:\nFAIL unit tests/company-clear.test.ts" }]),
  });
  expect(attentionCardFromBlocker(undefined, {
    pendingAction: "Review the verification result and decide whether the task can continue after the base branch fails.",
  }).title).toBe("Review the verification result and decide whether the task can continue after");
});
