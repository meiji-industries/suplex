import type { ApiProject, ApiTask } from "./view-shared.js";

export const FORGE_REPOSITORY = "meiji-industries/forge";

export type TaskDiagnostics = {
  workflow: { status: string; lastWorkflowTaskFailure: string | null; pendingWorkflowTaskAgeSeconds: number | null; buildId: string | null; currentBuildId: string | null };
  executions: Array<{ id: string; kind: string; status: string; pid: number | null; terminal: boolean }>;
  capacityRequests: Array<{ id: string; status: string; executionId: string | null }>;
  leases: Array<{ executionId: string; status: string }>;
};

export function findForgeProject(projects: readonly ApiProject[]): ApiProject | undefined {
  return projects.find((project) => project.name.trim().toLowerCase() === "forge" && project.repository?.trim().toLowerCase() === FORGE_REPOSITORY);
}

function oneLine(value: string, maximum = 160): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1).trimEnd()}…`;
}

function bounded(value: string, maximum = 4_000): string {
  const trimmed = value.trim();
  return trimmed.length <= maximum ? trimmed : `${trimmed.slice(0, maximum - 1).trimEnd()}…`;
}

function list(values: string[]): string { return values.length ? values.join(", ") : "none"; }

export function fixTaskDraft(task: ApiTask, diagnostics: TaskDiagnostics | undefined, sourceUrl: string, capturedAt = new Date().toISOString()): { title: string; description: string } {
  const failedInvocation = [...task.agentInvocations].reverse().find((invocation) => invocation.failureCode || invocation.failureSummary || invocation.status === "failed");
  const failure = failedInvocation?.failureCode ?? task.lastHandlerError?.reason ?? (task.phase === "failed" ? task.pendingAction : null);
  const title = failure
    ? `Fix Forge task failure: ${oneLine(failure, 92)}`
    : `Fix Forge behavior observed in ${oneLine(task.issueKey ?? task.title, 88)}`;
  const invocation = failedInvocation
    ? [failedInvocation.role, failedInvocation.agentName, failedInvocation.model, failedInvocation.status, failedInvocation.failureCode].filter((value): value is string => Boolean(value)).join(" · ")
    : "none";
  const observed = [
    `- Task: ${task.issueKey ?? task.id} (${task.id})`,
    `- Workflow: ${task.workflowId}`,
    `- Phase: ${task.phase}`,
    `- Owner: ${task.owner}`,
    `- Revision: ${task.revision}`,
    `- Pending action: ${task.pendingAction ?? "none"}`,
    `- Projection revision: ${task.projection.revision}`,
    `- Last handler error: ${task.lastHandlerError ? `${task.lastHandlerError.command} · ${oneLine(task.lastHandlerError.reason)} · ${task.lastHandlerError.at}` : "none"}`,
    `- Failed invocation: ${invocation}`,
    `- Invocation summary: ${failedInvocation?.failureSummary ? oneLine(failedInvocation.failureSummary, 500) : "none"}`,
    `- Capacity shown by task: ${task.capacity ? `${task.capacity.status}${task.capacity.position ? ` · position ${task.capacity.position}` : ""}` : "none"}`,
  ];
  const diagnosticLines = diagnostics ? [
    `- Workflow status: ${diagnostics.workflow.status}`,
    `- Workflow task failure: ${diagnostics.workflow.lastWorkflowTaskFailure ? oneLine(diagnostics.workflow.lastWorkflowTaskFailure, 500) : "none"}`,
    `- Executions: ${list(diagnostics.executions.map((entry) => `${entry.kind} ${entry.status}${entry.terminal ? " (terminal)" : ""} [${entry.id}]`))}`,
    `- Capacity requests: ${list(diagnostics.capacityRequests.map((entry) => `${entry.status} [${entry.id}]`))}`,
    `- Leases: ${list(diagnostics.leases.map((entry) => `${entry.status} [${entry.executionId}]`))}`,
  ] : ["- Diagnostics endpoint was unavailable when this draft was prepared."];

  return {
    title,
    description: [
      "## Source task",
      "",
      sourceUrl,
      "",
      "## Reported issue",
      "",
      bounded(task.description) || "No task description was provided.",
      "",
      "## Observed Forge state",
      "",
      ...observed,
      "",
      "## Diagnostic snapshot",
      "",
      `Captured at ${capturedAt}.`,
      "",
      ...diagnosticLines,
      "",
      "## Goal",
      "",
      "Determine the evidence-backed root cause in Forge and implement the smallest robust fix. Do not assume the source task's original hypothesis is correct; reconcile it with the observed state and diagnostics above.",
      "",
      "Prefer simplifying or removing unnecessary logic and special cases. Add new state, retries, configuration, or abstractions only when the evidence requires them. Keep task state truthful and actionable.",
      "",
      "## Acceptance criteria",
      "",
      "- Explain the root cause using evidence from the source task and Forge code.",
      "- Implement the smallest fix that addresses the observed behavior.",
      "- Add a focused regression test reproducing the failure or misleading state.",
      "- Avoid expanding orchestration logic when existing behavior can be simplified.",
    ].join("\n"),
  };
}
