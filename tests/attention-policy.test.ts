import { describe, expect, test } from "vitest";

import { attentionPolicy } from "../src/attention-policy.js";
import { IssueBlockerSchema, type AttentionCategory, type IssueBlocker, type IssueCommand, type IssuePhase } from "../src/temporal/issue-contracts.js";

const timestamp = "2026-08-11T00:00:00.000Z";
const evidence = { artifactId: "artifact_attention", sha256: "a".repeat(64), kind: "attention-evidence" as const };

function input(phase: IssuePhase, allowedCommands: IssueCommand[], blocker: IssueBlocker | null | undefined, revision = 7) {
  return { companyId: "company-a", taskId: "task-a", taskTitle: "Task A", workflowId: "workflow-a", phase, revision, owner: blocker?.unblockOwner === "human" ? "human" as const : "lead" as const, allowedCommands, blocker: blocker === undefined ? undefined : blocker ? IssueBlockerSchema.parse(blocker) : null, stateChangedAt: timestamp, projectedAt: timestamp };
}

function blocker(category: AttentionCategory, commands: IssueCommand[], retry: { attempt: number; retryAt: string | null; exhausted: boolean } | null = null, unblockOwner: IssueBlocker["unblockOwner"] = "human") {
  return IssueBlockerSchema.parse({ category, summary: `${category} needs attention`, unblockOwner, actions: commands.map((command) => ({ command, label: command, requiresNote: ["reject_plan", "record_delivery_decision", "request_delivery_changes"].includes(command), destructive: command === "cancel_issue" })), evidence, createdAt: timestamp, retry });
}

describe("attention policy", () => {
  const rows: Array<{ name: string; phase: IssuePhase; commands: IssueCommand[]; blocker: ReturnType<typeof blocker> | null; expected: "quiet" | "unknown" | AttentionCategory; expectedCommands?: IssueCommand[] }> = [
    { name: "backlog", phase: "backlog", commands: ["start_planning"], blocker: null, expected: "quiet" },
    { name: "lead planning", phase: "planning", commands: [], blocker: null, expected: "quiet" },
    { name: "material approval", phase: "approval", commands: ["approve_plan", "reject_plan"], blocker: blocker("member_authorization", ["approve_plan", "reject_plan"]), expected: "member_authorization", expectedCommands: ["approve_plan", "reject_plan"] },
    { name: "routine plan", phase: "ready_for_development", commands: ["start_development"], blocker: null, expected: "quiet" },
    { name: "developer running", phase: "development", commands: [], blocker: null, expected: "quiet" },
    { name: "developer retry", phase: "delivery_blocked", commands: ["retry_development"], blocker: null, expected: "quiet" },
    { name: "member decision", phase: "delivery_blocked", commands: ["record_delivery_decision"], blocker: blocker("member_decision", ["record_delivery_decision"]), expected: "member_decision", expectedCommands: ["record_delivery_decision"] },
    { name: "unsafe ownership", phase: "delivery_blocked", commands: ["cancel_issue"], blocker: blocker("unsafe_recovery", ["cancel_issue"]), expected: "unsafe_recovery", expectedCommands: ["cancel_issue"] },
    { name: "repair remains", phase: "repair_required", commands: ["repair_delivery"], blocker: null, expected: "quiet" },
    { name: "contradiction exhausted", phase: "failed", commands: ["record_delivery_decision", "cancel_issue"], blocker: blocker("agent_contradiction", ["record_delivery_decision", "cancel_issue"]), expected: "agent_contradiction", expectedCommands: ["record_delivery_decision", "cancel_issue"] },
    { name: "provider retry", phase: "releasing", commands: ["reconcile_merge"], blocker: blocker("provider_connectivity_exhausted", ["reconcile_merge"], { attempt: 1, retryAt: timestamp, exhausted: false }, "system"), expected: "quiet" },
    { name: "provider authentication", phase: "delivery_blocked", commands: ["reconcile_merge"], blocker: blocker("provider_authentication", ["reconcile_merge"]), expected: "provider_authentication", expectedCommands: ["reconcile_merge"] },
    { name: "provider exhausted", phase: "delivery_blocked", commands: ["reconcile_merge"], blocker: blocker("provider_connectivity_exhausted", ["reconcile_merge"], { attempt: 3, retryAt: null, exhausted: true }), expected: "provider_connectivity_exhausted", expectedCommands: ["reconcile_merge"] },
    { name: "verification unrecoverable", phase: "ci_repair_required", commands: ["request_delivery_changes", "cancel_issue"], blocker: blocker("verification_unrecoverable", ["request_delivery_changes", "cancel_issue"]), expected: "verification_unrecoverable", expectedCommands: ["request_delivery_changes", "cancel_issue"] },
    { name: "target drift", phase: "delivery_blocked", commands: ["cancel_issue"], blocker: blocker("target_drift", ["cancel_issue"]), expected: "target_drift", expectedCommands: ["cancel_issue"] },
    { name: "final acceptance", phase: "accepted", commands: ["accept_delivery", "request_delivery_changes"], blocker: blocker("member_authorization", ["accept_delivery", "request_delivery_changes"]), expected: "member_authorization", expectedCommands: ["accept_delivery", "request_delivery_changes"] },
    { name: "manual merge", phase: "manual_merge", commands: ["reconcile_merge"], blocker: null, expected: "quiet" },
    { name: "capacity queued", phase: "development", commands: [], blocker: null, expected: "quiet" },
    { name: "capacity exhausted", phase: "failed", commands: ["cancel_issue"], blocker: blocker("capacity_exhausted", ["cancel_issue"]), expected: "capacity_exhausted", expectedCommands: ["cancel_issue"] },
    { name: "done", phase: "done", commands: [], blocker: null, expected: "quiet" },
    { name: "cancelled", phase: "cancelled", commands: [], blocker: null, expected: "quiet" },
  ];

  test.each(rows)("$name", (row) => {
    const result = attentionPolicy(input(row.phase, row.commands, row.blocker));
    if (row.expected === "quiet") expect(result).toMatchObject({ kind: "quiet", projectionStatus: "current" });
    else if (row.expected === "unknown") expect(result).toMatchObject({ kind: "quiet", projectionStatus: "unknown" });
    else expect(result).toMatchObject({ kind: "attention", projectionStatus: "current", item: { category: row.expected, actions: row.expectedCommands?.map((command) => expect.objectContaining({ command })) } });
  });

  test("legacy fields never invent attention", () => {
    expect(attentionPolicy(input("approval", ["approve_plan"], undefined))).toMatchObject({ kind: "quiet", projectionStatus: "unknown" });
    const legacy = input("approval", ["approve_plan"], null);
    delete (legacy as { stateChangedAt?: string }).stateChangedAt;
    expect(attentionPolicy(legacy)).toMatchObject({ kind: "quiet", projectionStatus: "unknown" });
  });

  test("missing legal action makes the projection unknown", () => {
    expect(attentionPolicy(input("approval", ["approve_plan"], blocker("member_authorization", ["approve_plan", "reject_plan"]))))
      .toMatchObject({ kind: "quiet", projectionStatus: "unknown" });
  });

  test("retrying blockers stay quiet for any elapsed duration", () => {
    const result = attentionPolicy(input("releasing", ["reconcile_merge"], { ...blocker("provider_connectivity_exhausted", ["reconcile_merge"], { attempt: 1, retryAt: timestamp, exhausted: false }) }));
    expect(result).toMatchObject({ kind: "quiet", projectionStatus: "current" });
  });
});
