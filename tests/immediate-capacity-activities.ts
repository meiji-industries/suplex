import type { CapacityAdmissionResult, CapacityRequestInput, CapacityRequestSnapshot, CapacityTerminalReason } from "../src/capacity-contracts.js";

export function createImmediateCapacityActivities() {
  const requests = new Map<string, CapacityRequestSnapshot>();
  let sequence = 0;

  const replace = (requestId: string, patch: Partial<CapacityRequestSnapshot>): CapacityRequestSnapshot => {
    const current = requests.get(requestId);
    if (!current) throw new Error(`Unknown immediate capacity request ${requestId}`);
    const next = { ...current, ...patch, updatedAt: current.updatedAt };
    requests.set(requestId, next);
    return next;
  };
  const inspectCapacity = async ({ requestId }: { requestId: string }): Promise<CapacityRequestSnapshot> => {
    const request = requests.get(requestId);
    if (!request) throw new Error(`Unknown immediate capacity request ${requestId}`);
    return request;
  };
  const publicState = (request: CapacityRequestSnapshot): CapacityAdmissionResult["publicState"] => ({
    requestId: request.id,
    logicalTurnKey: request.logicalTurnKey,
    workflowRevision: request.workflowRevision,
    operation: request.operation,
    role: request.role,
    profileId: request.profileId,
    laneKey: request.laneKey,
    status: request.status,
    position: null,
    reason: request.waitReason,
    requestedAt: request.requestedAt,
    retryAt: request.retryAt,
    rateLimitAttempts: request.rateLimitAttempts,
  });

  const activities = {
    async requestCapacity(input: CapacityRequestInput): Promise<CapacityRequestSnapshot> {
      const existing = [...requests.values()].find((request) => request.logicalTurnKey === input.logicalTurnKey && ["queued", "active", "rate_limited"].includes(request.status));
      if (existing) return existing;
      const requestedAt = input.requestedAt ?? "2026-01-01T00:00:00.000Z";
      const request: CapacityRequestSnapshot = {
        id: `capacity:${sequence += 1}`,
        logicalTurnKey: input.logicalTurnKey,
        companyId: input.companyId,
        taskId: input.taskId,
        workflowId: input.workflowId,
        projectRevisionId: input.projectRevisionId,
        workflowRevision: input.workflowRevision,
        operation: input.operation,
        role: input.role,
        profileId: input.profileId,
        provider: "codex",
        model: "test-model",
        reasoningLevel: "medium",
        servicePriority: "standard",
        laneKey: `codex:${input.profileId}`,
        requestedCapacity: 32,
        status: "queued",
        waitReason: null,
        skipReason: null,
        sessionRef: input.sessionRef ?? null,
        worktreePath: input.worktreePath ?? null,
        executionKind: null,
        executionId: null,
        requestedAt,
        deadlineAt: "2099-01-01T00:00:00.000Z",
        acquiredAt: null,
        heartbeatAt: null,
        retryAt: null,
        cancelledAt: null,
        releasedAt: null,
        updatedAt: requestedAt,
        rateLimitAttempts: 0,
        terminalReason: null,
      };
      requests.set(request.id, request);
      return request;
    },
    async tryAcquireCapacity({ requestId }: { requestId: string; expectedWorkflowRevision: number }): Promise<CapacityAdmissionResult> {
      const request = replace(requestId, { status: "active", waitReason: null, acquiredAt: "2026-01-01T00:00:00.000Z" });
      return { status: "active", publicState: publicState(request) };
    },
    inspectCapacity,
    async requeueCapacity({ requestId }: { requestId: string; now?: string }): Promise<CapacityRequestSnapshot> {
      return replace(requestId, { status: "queued", waitReason: null, retryAt: null });
    },
    async cancelCapacity({ requestId, reason }: { requestId: string; reason?: string }): Promise<CapacityRequestSnapshot> {
      return replace(requestId, { status: "cancelled", skipReason: reason ?? "cancelled", cancelledAt: "2026-01-01T00:00:00.000Z", releasedAt: "2026-01-01T00:00:00.000Z", terminalReason: "cancelled" });
    },
    async finalizeCapacity({ requestId, terminalReason }: { requestId: string; expectedExecutionId: string; terminalReason: CapacityTerminalReason }): Promise<CapacityRequestSnapshot> {
      return replace(requestId, { status: "released", releasedAt: "2026-01-01T00:00:00.000Z", terminalReason });
    },
    async rateLimitCapacity({ requestId, retryAt }: { requestId: string; executionId: string; retryAt?: string }): Promise<CapacityRequestSnapshot> {
      const current = await inspectCapacity({ requestId });
      return replace(requestId, { status: "rate_limited", waitReason: "rate_limit_reset", retryAt: retryAt ?? "2026-01-01T00:01:00.000Z", rateLimitAttempts: current.rateLimitAttempts + 1, terminalReason: "rate_limited" });
    },
    async cancelCapacityExecution({ requestId }: { requestId: string }): Promise<{ status: "cancelled"; reason: string }> {
      replace(requestId, { status: "cancelled", cancelledAt: "2026-01-01T00:00:00.000Z", releasedAt: "2026-01-01T00:00:00.000Z", terminalReason: "cancelled" });
      return { status: "cancelled", reason: "cancelled" };
    },
    async reconcileCapacityOwnership(): Promise<[]> { return []; },
  };

  return { activities, owns: (requestId: string): boolean => requests.has(requestId) };
}
