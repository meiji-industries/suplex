import { createHash } from "node:crypto";

import { z } from "zod";

const processArg = z.string().min(1).max(4_000);
const processIdentity = z.object({
  pid: z.number().int().positive(),
  processGroup: z.number().int().positive(),
  startTime: z.string().min(1).max(200),
  executable: z.string().min(1).max(4_000),
  argv: z.array(processArg).max(256),
  ownerUid: z.number().int().nonnegative().nullable(),
}).strict();

export const DeveloperSupervisorInvocationSchema = z.object({
  version: z.literal(1),
  executionId: z.string().regex(/^developer_[a-f0-9]{24}$/),
  command: z.string().min(1).max(4_000),
  args: z.array(processArg).max(256),
  cwd: z.string().min(1).max(4_000),
  env: z.record(z.string(), z.string()),
}).strict();

export type DeveloperSupervisorInvocation = z.infer<typeof DeveloperSupervisorInvocationSchema>;

export const DeveloperSupervisorIdentitySchema = processIdentity;
export type DeveloperSupervisorIdentity = z.infer<typeof DeveloperSupervisorIdentitySchema>;

export const DeveloperSupervisorSnapshotSchema = z.object({
  version: z.literal(1),
  executionId: z.string().regex(/^developer_[a-f0-9]{24}$/),
  status: z.enum(["starting", "running", "result_ready", "cancelling", "terminated", "failed"]),
  supervisor: processIdentity,
  child: processIdentity.nullable(),
  heartbeatAt: z.string().datetime(),
  resultHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  exitCode: z.number().int().nullable().optional(),
  exitSignal: z.string().max(32).nullable().optional(),
  termSentAt: z.string().datetime().nullable().optional(),
  killSentAt: z.string().datetime().nullable().optional(),
  confirmedExitAt: z.string().datetime().nullable().optional(),
}).strict();

export type DeveloperSupervisorSnapshot = z.infer<typeof DeveloperSupervisorSnapshotSchema>;

export const DeveloperSupervisorHeartbeatSchema = z.object({
  version: z.literal(1),
  executionId: z.string().regex(/^developer_[a-f0-9]{24}$/),
  status: z.enum(["starting", "running", "result_ready", "cancelling", "terminated", "failed"]),
  heartbeatAt: z.string().datetime(),
}).strict();

export type DeveloperSupervisorHeartbeat = z.infer<typeof DeveloperSupervisorHeartbeatSchema>;

export const DeveloperSupervisorResultSchema = z.object({
  version: z.literal(1),
  executionId: z.string().regex(/^developer_[a-f0-9]{24}$/),
  leaseTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  supervisor: processIdentity,
  child: processIdentity,
  exitCode: z.number().int().nullable(),
  exitSignal: z.string().max(32).nullable(),
  outputPath: z.literal("events.jsonl"),
  outputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  outputTruncated: z.boolean(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  resultHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type DeveloperSupervisorResult = z.infer<typeof DeveloperSupervisorResultSchema>;

const token = z.string().min(1).max(256);
export const DeveloperSupervisorRequestSchema = z.discriminatedUnion("command", [
  z.object({ version: z.literal(1), command: z.literal("status"), executionId: z.string().regex(/^developer_[a-f0-9]{24}$/), leaseToken: token }).strict(),
  z.object({ version: z.literal(1), command: z.literal("cancel"), executionId: z.string().regex(/^developer_[a-f0-9]{24}$/), leaseToken: token, termGraceMs: z.number().int().min(0).max(30_000), killGraceMs: z.number().int().min(0).max(30_000) }).strict(),
]);

export type DeveloperSupervisorRequest = z.infer<typeof DeveloperSupervisorRequestSchema>;

export const DeveloperSupervisorResponseSchema = z.discriminatedUnion("status", [
  z.object({ version: z.literal(1), status: z.enum(["starting", "running", "result_ready", "cancelling", "terminated", "failed"]), supervisor: processIdentity, child: processIdentity.nullable(), heartbeatAt: z.string().datetime(), resultHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), exitCode: z.number().int().nullable().optional(), exitSignal: z.string().max(32).nullable().optional(), termSentAt: z.string().datetime().nullable().optional(), killSentAt: z.string().datetime().nullable().optional(), confirmedExitAt: z.string().datetime().nullable().optional() }).strict(),
  z.object({ version: z.literal(1), status: z.literal("termination_failed"), reasonCode: z.string().min(1).max(100), summary: z.string().min(1).max(500) }).strict(),
]);

export type DeveloperSupervisorResponse = z.infer<typeof DeveloperSupervisorResponseSchema>;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function supervisorResultHash(result: Omit<DeveloperSupervisorResult, "resultHash">): string {
  return sha256(canonicalJson(result));
}

export function withSupervisorResultHash(result: Omit<DeveloperSupervisorResult, "resultHash">): DeveloperSupervisorResult {
  return DeveloperSupervisorResultSchema.parse({ ...result, resultHash: supervisorResultHash(result) });
}

export function validateSupervisorResult(raw: unknown): DeveloperSupervisorResult {
  const result = DeveloperSupervisorResultSchema.parse(raw);
  const { resultHash, ...withoutHash } = result;
  if (supervisorResultHash(withoutHash) !== resultHash) throw new Error("Developer supervisor result hash is invalid");
  return result;
}
