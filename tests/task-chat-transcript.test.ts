import { describe, expect, it } from "vitest";

import { buildChatTranscript, chatEventFromTimelineEvent, compactChatEvents, mergeChatEvent, type ChatEvent, type ChatItem } from "../src/frontend/lib/task-chat.js";
import type { ApiTask } from "../src/frontend/lib/view-shared.js";

const at = (second: number) => `2026-08-23T00:00:${String(second).padStart(2, "0")}.000Z`;
const task = (overrides: Partial<ApiTask> = {}): ApiTask => ({ id: "task-chat", companyId: "company", projectId: "project", issueKey: null, title: "Chat", description: "Build **this**", briefArtifactId: "brief", images: [], roleAgents: {}, supplementalReview: false, autoApprovePlan: true, deliveryTarget: "pull_request", executionControls: { runProjectTests: true, visualEvidence: false, supplementalReview: false }, deliveryReceipt: null, pullRequestMode: "draft", workflowId: "workflow", projectRevisionId: "revision", prompts: { overrides: [] }, phase: "planning", revision: 1, owner: "human", allowedCommands: [], commands: [], governance: { blocker: null }, pendingAction: null, createdAt: at(1), updatedAt: at(50), projection: { revision: 1, projectedAt: at(1) }, timeline: [], activity: [{ id: "created", revision: 0, eventType: "task_created", metadata: {}, createdAt: at(1), kind: "member", actor: { id: "member", displayName: "Mara", username: "mara", avatarSeed: "mara" } }], agentInvocations: [], capacity: null, targetBaseReconciliation: { checkId: null, checkpoint: null, status: null, expectedBaseSha: null, observedBaseSha: null, priorHead: null, priorTree: null, resultHead: null, resultTree: null, conflictFileCount: null, conflictArtifact: null, verificationArtifact: null, deliveryArtifact: null, invalidatedDeliveryReviewId: null, invalidatedCiRunId: null, invalidatedFinalReviewId: null, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, blockerCode: null, blockerOwner: null, retryable: null, summary: null, actions: [] }, reviewLineage: { currentReview: null, priorReviews: [], reviewAttempts: [], repairAttempts: [] }, planHistory: [], planDecisionHistory: [], revisionHistory: [], developerExecutionHistory: [], deliveryReviewHistory: [], ...overrides } as ApiTask);
const planner = (id: string, startedAt: string, finishedAt: string | null) => ({ id, role: "planner" as const, status: finishedAt ? "completed" : "running", attempt: 1, sessionPresent: true, sessionRef: null, startedAt, finishedAt, failureCode: null, failureSummary: null, evidenceArtifactId: null, agentName: "Planner", avatarSeed: "planner" });
const reviewer = (id: string, startedAt: string, finishedAt: string | null) => ({ ...planner(id, startedAt, finishedAt), role: "reviewer" as const, agentName: "Reviewer", avatarSeed: "reviewer" });
const deliveryReview = (id: string, leadExecutionId: string, outcome: "approved" | "blocking", summary: string, createdAt: string): ApiTask["deliveryReviewHistory"][number] => ({ id, leadExecutionId, outcome, summary, planRevision: 1, baseSha: "base", subjectCommit: "commit", subjectTree: "tree", opinionArtifactId: "opinion", evidenceArtifactId: "evidence", repairCycle: 0, createdAt });

describe("buildChatTranscript", () => {
  it("replaces a duplicate chat event in place without mutating the transcript", () => {
    const first: ChatEvent = { id: "first", at: at(1), kind: "message", text: "First" };
    const original: ChatEvent = { id: "replace", at: at(2), kind: "message", text: "Before" };
    const last: ChatEvent = { id: "last", at: at(3), kind: "message", text: "Last" };
    const replacement: ChatEvent = { ...original, text: "After" };
    const events = [first, original, last];

    const replaced = mergeChatEvent(events, replacement);
    const appended = mergeChatEvent(replaced, { id: "new", at: at(4), kind: "message", text: "New" });

    expect(replaced).not.toBe(events);
    expect(replaced).toEqual([first, replacement, last]);
    expect(events).toEqual([first, original, last]);
    expect(appended).not.toBe(replaced);
    expect(appended).toEqual([...replaced, { id: "new", at: at(4), kind: "message", text: "New" }]);
  });

  it("maps neutral rollout events without parsing command prose", () => {
    expect(chatEventFromTimelineEvent({ streamId: 1, id: "timeline", eventType: "file_change", metadata: { kind: "file_change", data: { path: "src/app.ts", status: "modified" } }, createdAt: at(1), executionId: "execution", executionRole: "builder", sessionId: "session", forgeTurnId: "turn" })).toEqual({ id: "timeline", at: at(1), kind: "file_change", text: "src/app.ts", files: ["src/app.ts"], exitCode: null });
  });

  it("preserves only the recognized final-answer phase", () => {
    const event = (phase: unknown) => chatEventFromTimelineEvent({ streamId: 1, id: "timeline", eventType: "message", metadata: { kind: "message", data: { role: "agent", phase, text: "Done" } }, createdAt: at(1), executionId: "execution", executionRole: "builder", sessionId: "session", forgeTurnId: "turn" });
    expect(event("final_answer")).toMatchObject({ phase: "final_answer" });
    expect(event("progress")).not.toHaveProperty("phase");
  });

  it("retains validated patches through timeline conversion and hides their empty acknowledgement", () => {
    const event = (id: string, kind: string, data: Record<string, unknown>) => chatEventFromTimelineEvent({ streamId: 1, id, eventType: kind, metadata: { kind, data }, createdAt: at(1), executionId: "execution", executionRole: "builder", sessionId: "session", forgeTurnId: "turn" })!;
    const patch = { files: [{ path: "src/a.ts", operation: "Edit", additions: 1, deletions: 1, rows: [{ kind: "deletion", text: "old", oldLine: 1 }, { kind: "addition", text: "new", newLine: 1 }] }] };
    const command = event("patch", "command", { id: "call-patch", text: "Apply patch", patch });
    expect(command.patch).toEqual(patch);
    expect(compactChatEvents([command, event("ack", "tool_call", { id: "call-patch", output: "{}" })])).toMatchObject([expect.objectContaining({ id: "patch", patch })]);
    expect(event("bad", "command", { id: "call-bad", text: "Apply patch", patch: { files: [{ path: "/tmp/a.ts" }] } }).patch).toBeUndefined();
  });

  it("hides human rollout scaffolding and lifecycle events", () => {
    const event = (id: string, kind: string, data: Record<string, unknown>) => chatEventFromTimelineEvent({ streamId: 1, id, eventType: kind, metadata: { kind, data }, createdAt: at(1), executionId: "execution", executionRole: "builder", sessionId: "session", forgeTurnId: "turn" });
    expect(event("forge", "message", { role: "human", text: "[forge-turn:turn] completion contract" })).toBeUndefined();
    expect(event("environment", "message", { role: "human", text: "  <environment_context>" })).toBeUndefined();
    expect(event("agents", "message", { role: "human", text: "# AGENTS.md instructions for /Users/dev/code/forge" })).toBeUndefined();
    expect(event("steering", "message", { role: "human", text: "Please also cover the edge case." })).toBeUndefined();
    expect(event("started", "turn_started", {})).toBeUndefined();
    expect(event("finished", "turn_finished", {})).toBeUndefined();
    expect(event("usage", "usage", {})).toBeUndefined();
  });

  it("renders member steering from task activity instead of rollout messages", () => {
    const value = buildChatTranscript(task({ activity: [{ id: "steering", revision: 1, eventType: "planner_note", metadata: { note: "Please also cover the edge case." }, createdAt: at(10), kind: "member", actor: { id: "member", displayName: "Mara", username: "mara", avatarSeed: "mara" } }] }));
    expect(value).toContainEqual(expect.objectContaining({ kind: "member", markdown: "Please also cover the edge case." }));
  });

  it("keeps the brief first and retains planner-note rounds with their turns", () => {
    const value = buildChatTranscript(task({ activity: [{ id: "created", revision: 0, eventType: "task_created", metadata: {}, createdAt: at(1), kind: "member" }, { id: "note-1", revision: 1, eventType: "planner_note", metadata: { note: "Revise A" }, createdAt: at(10), kind: "member" }, { id: "summary-1", revision: 2, eventType: "planner_note_revised", metadata: { summary: "Plan A" }, createdAt: at(20), kind: "workflow" }, { id: "note-2", revision: 3, eventType: "planner_note", metadata: { note: "Revise B" }, createdAt: at(30), kind: "member" }, { id: "summary-2", revision: 4, eventType: "planner_note_revised", metadata: { summary: "Plan B" }, createdAt: at(40), kind: "workflow" }], agentInvocations: [planner("one", at(11), at(20)), planner("two", at(31), at(40))] }));
    expect(value.map((item) => item.kind)).toEqual(["member", "member", "agent_turn", "member", "agent_turn"]);
    expect(value[0]).toMatchObject({ markdown: "Build **this**" });
    expect(value.filter((item) => item.kind === "agent_turn").map((item) => item.summary)).toEqual(["Plan A", "Plan B"]);
  });

  it("keeps running events, PR placement, and only meaningful system lines", () => {
    const events: ChatEvent[] = [{ id: "event", at: at(12), kind: "agent_update", text: "Working" }];
    const value = buildChatTranscript(task({ activity: [{ id: "created", revision: 0, eventType: "task_created", metadata: {}, createdAt: at(1), kind: "member" }, { id: "approved", revision: 1, eventType: "phase_plan_approved", metadata: {}, createdAt: at(5), kind: "workflow" }, { id: "noise", revision: 2, eventType: "phase_development", metadata: {}, createdAt: at(6), kind: "workflow" }, { id: "ci", revision: 3, eventType: "phase_ci_passed", metadata: {}, createdAt: at(7), kind: "workflow" }, { id: "merged", revision: 4, eventType: "github_pr_merged", metadata: {}, createdAt: at(30), kind: "workflow" }], agentInvocations: [planner("running", at(10), null)], githubPullRequest: { exists: true, number: 1, url: "https://example.com/pr/1", state: "open", isDraft: false, autoMergeEnabled: false, observedAt: at(25), changedFiles: null, additions: null, deletions: null, checks: { total: 0, pending: 0, failing: 0, successful: 0 }, mergeable: null, reviewDecision: null } }), new Map([["running", events]]));
    expect(value.find((item) => item.kind === "agent_turn")).toMatchObject({ finishedAt: null, intro: "Working", events: [] });
    expect(value.filter((item) => item.kind === "system").map((item) => item.text)).toEqual(["Plan approved automatically", "CI passed", "Merged"]);
    expect(value.find((item) => item.kind === "pull_request")).toMatchObject({ at: at(25) });
  });

  it("promotes the completed Planner recap despite its preceding planning marker", () => {
    const invocations = [planner("planner-62be", at(10), at(20)), planner("wrong-planner", at(30), at(40))];
    const value = buildChatTranscript(task({
      activity: [{ id: "planning-started", revision: 1, eventType: "planning_started", metadata: {}, createdAt: at(9), kind: "workflow" }],
      agentInvocations: invocations,
      leadOutput: { executionId: "planner-62be", summary: "Durable plan" } as ApiTask["leadOutput"],
      planHistory: [{ revision: 1, kind: "plan", summary: "Durable plan", executionId: "planner-62be", outputArtifactId: "output", evidenceArtifactId: "evidence", createdAt: at(20) }],
    }), new Map([["planner-62be", [
      { id: "progress-one", at: at(11), kind: "message", text: "Inspecting requirements" },
      { id: "progress-two", at: at(12), kind: "message", text: "Preparing the plan" },
      { id: "recap", at: at(19), kind: "message", text: "**Recap**\n\nThe final plan." },
    ]], ["wrong-planner", [{ id: "wrong-progress", at: at(31), kind: "message", text: "Other work" }]]]));
    const turns = value.filter((item): item is Extract<ChatItem, { kind: "agent_turn" }> => item.kind === "agent_turn");
    expect(turns[0]).toMatchObject({ id: "agent-planner-62be", events: [
      { id: "progress-one" },
      { id: "progress-two" },
      { id: "recap", phase: "final_answer", text: "**Recap**\n\nThe final plan." },
    ] });
    expect(turns[0]!.summary).toBeUndefined();
    expect(turns[0]!.events.filter((event) => event.phase === "final_answer")).toHaveLength(1);
    expect(turns[1]).toMatchObject({ id: "agent-wrong-planner", events: [{ id: "wrong-progress", phase: "final_answer" }] });
    expect(turns[1]!.summary).toBeUndefined();
  });

  it("uses a matching plan-history summary without a planning marker", () => {
    const value = buildChatTranscript(task({ agentInvocations: [planner("matching", at(10), at(20)), planner("wrong", at(30), at(40))], planHistory: [
      { revision: 1, kind: "plan", summary: "Matching plan", executionId: "matching", outputArtifactId: "output", evidenceArtifactId: "evidence", createdAt: at(20) },
    ] }));
    expect(value.filter((item) => item.kind === "agent_turn").map((item) => item.summary)).toEqual(["Matching plan", undefined]);
  });

  it("does not promote plain messages for incomplete terminal turns", () => {
    const failed = { ...planner("failed", at(10), at(20)), status: "failed" };
    const blocked = { ...planner("blocked", at(30), at(40)), status: "blocked" };
    const running = planner("running", at(50), null);
    const eventsByExecution = new Map<string, ChatEvent[]>([
      ["failed", [{ id: "failed-message", at: at(19), kind: "message", text: "Failed response" }]],
      ["blocked", [{ id: "blocked-message", at: at(39), kind: "message", text: "Blocked response" }]],
      ["running", [{ id: "running-message", at: at(51), kind: "message", text: "Running response" }]],
    ]);
    const value = buildChatTranscript(task({ agentInvocations: [failed, blocked, running] }), eventsByExecution);
    expect(value.filter((item): item is Extract<ChatItem, { kind: "agent_turn" }> => item.kind === "agent_turn").map((item) => item.events[0]?.phase)).toEqual([undefined, undefined, undefined]);
  });

  it("orders equal timestamps as member, turn, then system", () => {
    const value = buildChatTranscript(task({ activity: [{ id: "created", revision: 0, eventType: "task_created", metadata: {}, createdAt: at(1), kind: "member" }, { id: "note", revision: 1, eventType: "planner_note", metadata: { note: "Revise" }, createdAt: at(10), kind: "member" }, { id: "ci", revision: 2, eventType: "ci_passed", metadata: {}, createdAt: at(10), kind: "workflow" }], agentInvocations: [planner("one", at(10), at(20))] }));
    expect(value.slice(1).map((item) => item.kind)).toEqual(["member", "agent_turn", "system"]);
  });

  it("hides lifecycle command echoes but keeps a member decision", () => {
    const value = buildChatTranscript(task({ activity: [{ id: "created", revision: 0, eventType: "task_created", metadata: {}, createdAt: at(1), kind: "member" }, { id: "start", revision: 1, eventType: "member_action", metadata: { command: "start_planning" }, createdAt: at(2), kind: "member", actor: { id: "member", displayName: "Mara", username: "mara", avatarSeed: "mara" } }, { id: "approve", revision: 2, eventType: "member_action", metadata: { command: "approve_plan", note: "Ship it" }, createdAt: at(3), kind: "member", actor: { id: "member", displayName: "Mara", username: "mara", avatarSeed: "mara" } }] }));
    expect(value.filter((item) => item.kind === "member").map((item) => item.id)).toEqual(["task-brief", "approve"]);
  });

  it("uses the intro once and collapses command pairs and repeats", () => {
    const events: ChatEvent[] = [
      { id: "intro", at: at(10), kind: "agent_update", text: "I'll inspect the README" },
      { id: "start-1", at: at(11), kind: "command_started", stepNumber: 1, text: "Running: Inspecting Git state" },
      { id: "finish-1", at: at(12), kind: "command_finished", stepNumber: 1, text: "Ran (exit 0): Inspecting Git state", exitCode: 0 },
      ...[1, 2, 3, 4].map((number) => ({ id: `update-${number}`, at: at(12 + number), kind: "agent_update", text: "Checking files" })),
    ];
    const value = buildChatTranscript(task({ agentInvocations: [planner("one", at(10), at(20))] }), new Map([["one", events]]));
    const turn = value.find((item) => item.kind === "agent_turn");
    expect(turn).toMatchObject({ intro: "I'll inspect the README", events: [{ kind: "command", text: "Inspecting Git state", exitCode: 0 }, { text: "Checking files", count: 4 }] });
    expect(turn && turn.kind === "agent_turn" ? turn.events.some((event) => event.id === "intro") : false).toBe(false);
  });

  it("collapses consecutive identical tool calls while retaining their identifying payload", () => {
    const events = ["one", "two", "three"].map((id, index) => chatEventFromTimelineEvent({ streamId: index + 1, id, eventType: "tool_call", metadata: { kind: "tool_call", data: { name: "exec", id: `call-${id}`, status: "completed" } }, createdAt: at(10 + index), executionId: "one", executionRole: "planner", sessionId: "session", forgeTurnId: "turn" })!);
    const value = buildChatTranscript(task({ agentInvocations: [planner("one", at(10), at(20))] }), new Map([["one", events]]));
    expect(value.find((item) => item.kind === "agent_turn")).toMatchObject({ events: [{ kind: "tool_call", text: "exec", detail: "call-one", toolStatus: "completed", count: 3 }] });
  });

  it("keeps distinct command rows and joins a later output preview by call id", () => {
    const event = (id: string, kind: string, data: Record<string, unknown>) => chatEventFromTimelineEvent({ streamId: 1, id, eventType: kind, metadata: { kind, data }, createdAt: at(10), executionId: "one", executionRole: "planner", sessionId: "session", forgeTurnId: "turn" })!;
    const value = buildChatTranscript(task({ agentInvocations: [planner("one", at(10), at(20))] }), new Map([["one", [
      event("first", "command", { id: "call-one", text: "pwd" }),
      event("second", "command", { id: "call-two", text: "git status" }),
      event("output", "tool_call", { id: "call-one", output: "repo\nclean" }),
    ]]]));
    expect(value.find((item) => item.kind === "agent_turn")).toMatchObject({ events: [{ kind: "command", text: "pwd", output: "repo\nclean" }, { kind: "command", text: "git status" }] });
  });

  it("shows the delivery review outcome from its matching lead execution", () => {
    const value = buildChatTranscript(task({ agentInvocations: [reviewer("delivery-review", at(10), at(20))], deliveryReviewHistory: [deliveryReview("review", "delivery-review", "approved", "Ready to ship", at(19))] }));
    expect(value.find((item) => item.kind === "agent_turn")).toMatchObject({ summary: "Approved. Ready to ship" });
  });

  it("shows blocking findings below the delivery review outcome", () => {
    const review = deliveryReview("review", "delivery-review", "blocking", "Missing coverage", at(19));
    const value = buildChatTranscript(task({ agentInvocations: [reviewer("delivery-review", at(10), at(20))], deliveryReviewHistory: [review], deliveryReview: { ...review, findings: [{ id: "finding", severity: "blocking", rationale: "Add an edge-case test", evidenceRef: "test", disposition: "open", repairInstruction: null }] } }));
    expect(value.find((item) => item.kind === "agent_turn")).toMatchObject({ summary: "Blocking. Missing coverage\n- Add an edge-case test" });
  });

  it("does not repeat a previously rendered review summary", () => {
    const value = buildChatTranscript(task({ agentInvocations: [reviewer("first", at(10), at(20)), reviewer("second", at(30), at(40))], deliveryReviewHistory: [deliveryReview("first-review", "first", "approved", "Ready to ship", at(19)), deliveryReview("second-review", "second", "approved", "Ready to ship", at(39))] }));
    expect(value.filter((item) => item.kind === "agent_turn").map((item) => item.summary)).toEqual(["Approved. Ready to ship", undefined]);
  });
});
