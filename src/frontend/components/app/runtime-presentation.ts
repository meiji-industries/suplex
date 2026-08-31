import type { ApiAgentRuntime } from "../../lib/view-shared.js";

const runtimeDiagnosisLabel: Record<ApiAgentRuntime["diagnosis"], string> = { working: "Working", resting: "Resting", blocked: "Needs input", result_missing: "Result missing", recovering_runtime: "Reconnecting", runtime_unavailable: "Runtime unavailable", identity_conflict: "Identity conflict", unknown: "Runtime unknown" };

const livePaneRoleOrder: Record<ApiAgentRuntime["role"], number> = { planner: 0, builder: 1, reviewer: 2, integrator: 3 };

export function runtimeStatusLabel(runtime: Pick<ApiAgentRuntime, "diagnosis" | "liveStatus">): string {
  return runtime.diagnosis === "resting" && runtime.liveStatus === "active" ? "Idle" : runtimeDiagnosisLabel[runtime.diagnosis];
}

export function liveTaskPanes(taskId: string, runtime: readonly ApiAgentRuntime[]): ApiAgentRuntime[] {
  return runtime.filter((entry) => entry.taskId === taskId && entry.paneId !== null && entry.liveStatus === "active").sort((left, right) => livePaneRoleOrder[left.role] - livePaneRoleOrder[right.role]);
}
