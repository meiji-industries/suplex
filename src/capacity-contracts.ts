import { z } from "zod";

const durableId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const CapacityOperationSchema = z.enum([
  "lead_planning",
  "supplemental_review",
  "lead_consolidation",
  "developer_execution",
  "delivery_review",
  "delivery_repair_plan",
  "developer_repair",
  "final_review",
  "merge_conflict_plan",
  "merge_conflict_resolution",
  "ci_repair_plan",
  "ci_repair_execution",
]);
export type CapacityOperation = z.infer<typeof CapacityOperationSchema>;

export const CapacityRoleSchema = z.enum(["planner", "builder", "reviewer", "integrator"]);
export type CapacityRole = z.infer<typeof CapacityRoleSchema>;

const legacyRoles: Record<string, string> = { lead: "planner", analyst: "planner", developer: "builder", implementer: "builder" };
const PersistedCapacityRoleSchema = z.preprocess((value) => typeof value === "string" ? legacyRoles[value] ?? value : value, CapacityRoleSchema);

export const CapacityRequestStatusSchema = z.enum(["queued", "active", "rate_limited", "released", "cancelled", "stale", "exhausted"]);
export type CapacityRequestStatus = z.infer<typeof CapacityRequestStatusSchema>;

export const CapacityWaitReasonSchema = z.enum(["lane_full", "issue_active", "session_active", "worktree_active", "rate_limit_reset"]);
export type CapacityWaitReason = z.infer<typeof CapacityWaitReasonSchema>;

export const CapacityTerminalReasonSchema = z.enum(["completed", "failed_before_start", "process_failed", "cancelled", "proven_dead", "stored_result", "rate_limited", "wait_exhausted"]);
export type CapacityTerminalReason = z.infer<typeof CapacityTerminalReasonSchema>;

export const CapacitySettingsSchema = z.object({
  profileId: durableId,
  provider: z.literal("codex"),
  model: z.string().min(1).max(256),
  reasoningLevel: z.enum(["low", "medium", "high", "xhigh"]),
  servicePriority: z.enum(["standard", "priority", "fast"]),
  requestedCapacity: z.number().int().min(1).max(32),
});

export const WorkflowCapacityStateSchema = z.object({
  requestId: durableId,
  logicalTurnKey: z.string().min(1).max(512),
  workflowRevision: z.number().int().nonnegative().default(0),
  operation: CapacityOperationSchema,
  role: PersistedCapacityRoleSchema,
  profileId: durableId,
  laneKey: z.string().regex(/^codex:[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  status: CapacityRequestStatusSchema,
  position: z.number().int().positive().nullable(),
  reason: CapacityWaitReasonSchema.nullable(),
  requestedAt: z.string().datetime(),
  retryAt: z.string().datetime().nullable(),
  rateLimitAttempts: z.number().int().nonnegative(),
});
export type WorkflowCapacityState = z.infer<typeof WorkflowCapacityStateSchema>;

export const CapacityBlockerSchema = z.object({
  category: z.literal("capacity_exhausted"),
  summary: z.string().max(200),
  nextAction: z.string().max(200),
  resumeOperation: CapacityOperationSchema,
});
export type CapacityBlocker = z.infer<typeof CapacityBlockerSchema>;

export const CapacityRequestSnapshotSchema = z.object({
  id: durableId,
  logicalTurnKey: z.string().min(1).max(512),
  companyId: durableId,
  taskId: durableId,
  workflowId: durableId,
  projectRevisionId: durableId,
  workflowRevision: z.number().int().nonnegative(),
  operation: CapacityOperationSchema,
  role: CapacityRoleSchema,
  profileId: durableId,
  provider: z.literal("codex"),
  model: z.string().min(1).max(256),
  reasoningLevel: z.enum(["low", "medium", "high", "xhigh"]),
  servicePriority: z.enum(["standard", "priority", "fast"]),
  laneKey: z.string().regex(/^codex:[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  requestedCapacity: z.number().int().min(1).max(32),
  status: CapacityRequestStatusSchema,
  waitReason: CapacityWaitReasonSchema.nullable(),
  skipReason: z.string().max(200).nullable(),
  sessionRef: durableId.nullable(),
  worktreePath: z.string().max(1_000).nullable(),
  executionKind: z.enum(["agent", "developer"]).nullable(),
  executionId: durableId.nullable(),
  requestedAt: z.string().datetime(),
  deadlineAt: z.string().datetime(),
  acquiredAt: z.string().datetime().nullable(),
  heartbeatAt: z.string().datetime().nullable(),
  retryAt: z.string().datetime().nullable(),
  cancelledAt: z.string().datetime().nullable(),
  releasedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
  rateLimitAttempts: z.number().int().nonnegative(),
  terminalReason: CapacityTerminalReasonSchema.nullable(),
});
export type CapacityRequestSnapshot = z.infer<typeof CapacityRequestSnapshotSchema>;

export const CapacityRequestInputSchema = z.object({
  logicalTurnKey: z.string().min(1).max(512),
  companyId: durableId,
  taskId: durableId,
  workflowId: durableId,
  projectRevisionId: durableId,
  workflowRevision: z.number().int().nonnegative(),
  operation: CapacityOperationSchema,
  role: CapacityRoleSchema,
  profileId: durableId,
  sessionRef: durableId.nullable().optional(),
  worktreePath: z.string().max(1_000).nullable().optional(),
  requestedAt: z.string().datetime().optional(),
});
export type CapacityRequestInput = z.infer<typeof CapacityRequestInputSchema>;

export const CapacityAdmissionResultSchema = z.object({
  status: z.enum(["queued", "active", "rate_limited", "released", "cancelled", "stale", "exhausted"]),
  publicState: WorkflowCapacityStateSchema,
});
export type CapacityAdmissionResult = z.infer<typeof CapacityAdmissionResultSchema>;

export const CapacityExecutionOwnerSchema = z.object({
  executionKind: z.enum(["agent", "developer"]),
  executionId: durableId,
  sessionRef: durableId.nullable().optional(),
  worktreePath: z.string().max(1_000).nullable().optional(),
});
export type CapacityExecutionOwner = z.infer<typeof CapacityExecutionOwnerSchema>;

export const PublicCapacityStatusSchema = z.object({
  profileId: durableId,
  agentName: z.string().min(1).max(120),
  avatarSeed: z.string(),
  status: z.enum(["queued", "active", "rate_limited", "exhausted"]),
  position: z.number().int().positive().nullable(),
  reason: CapacityWaitReasonSchema.nullable(),
  requestedAt: z.string().datetime(),
  retryAt: z.string().datetime().nullable(),
});
export type PublicCapacityStatus = z.infer<typeof PublicCapacityStatusSchema>;

export const AdminCapacityLaneSchema = z.object({
  profileId: durableId,
  profileName: z.string().min(1).max(120),
  provider: z.literal("codex"),
  capacity: z.number().int().min(1).max(32).nullable(),
  effectiveCapacity: z.number().int().min(1).max(32),
  activeCount: z.number().int().nonnegative(),
  queuedCount: z.number().int().nonnegative(),
  rateLimitedCount: z.number().int().nonnegative(),
  oldestQueuedAt: z.string().datetime().nullable(),
});
export type AdminCapacityLane = z.infer<typeof AdminCapacityLaneSchema>;

export const CapacityReconciliationResultSchema = z.object({
  requestId: durableId,
  status: CapacityRequestStatusSchema,
  reason: z.string().max(200),
});
export type CapacityReconciliationResult = z.infer<typeof CapacityReconciliationResultSchema>;
