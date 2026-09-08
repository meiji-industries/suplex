import { z } from "zod";
import { RecommendedQuestionOptionsSchema } from "./human-question.js";
import { AdvisorRoleSchema } from "./workflows.js";

const opaqueId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const RootIdentitySchema = z.object({
  taskId: opaqueId,
  sessionId: opaqueId,
  generation: z.number().int().positive(),
}).strict();

export type RootIdentity = z.infer<typeof RootIdentitySchema>;

export const DeliveryOperationSchema = z.enum([
  "inspect_delivery_diff",
  "complete_local_work",
  "push_branch",
  "create_or_adopt_pull_request",
  "observe_pull_request",
  "observe_checks",
  "request_review",
  "merge_pull_request",
]);
export type DeliveryOperation = z.infer<typeof DeliveryOperationSchema>;

export const DeliveryReviewSchema = z.object({
  baseSha: z.string().regex(/^[a-f0-9]{40,64}$/),
  headSha: z.string().regex(/^[a-f0-9]{40,64}$/),
  files: z.array(z.string().min(1)),
  commits: z.array(z.string().regex(/^[a-f0-9]{40,64}$/)),
  patchDigest: z.string().optional(),
}).strict();
export type DeliveryReview = z.infer<typeof DeliveryReviewSchema>;

export const PullRequestTitleSchema = z.string().refine(
  value => !/[\x00-\x1f\x7f]/.test(value),
  "Pull request titles cannot contain line breaks or control characters",
).trim().min(1).max(120);
export type PullRequestTitle = z.infer<typeof PullRequestTitleSchema>;

const WorkerAssignmentShape = z.object({
  plan: z.string().trim().min(1).optional().describe("The Coordinator's implementation plan, based on its own source investigation. Include the chosen approach, affected files, and constraints. Mandatory in planned mode; omitted in direct mode."),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1).describe("Concrete outcomes and checks the Coordinator will use to review the implementation."),
  instruction: z.string().trim().min(1).describe("Specific implementation or check commands for the Worker. Planning and final review remain with the Coordinator."),
  mode: z.enum(["planned", "direct"]).optional().describe("planned (default) requires a plan. direct is legal only for the Direct build workflow."),
  purpose: z.enum(["implementation", "verification"]).optional().describe("verification runs the specified checks on the pinned revision without intentional source edits."),
  advisorTurnId: opaqueId.optional().describe("Pull request repair: the exact latest valid current-range Rater report turn that the Worker implements."),
  candidateTurnIds: z.tuple([opaqueId, opaqueId]).optional().describe("Combined planning: the exact Plan A and Plan B report turns, in that order, that the combined plan resolves."),
  advisorSessionId: opaqueId.optional().describe("Legacy form of advisorTurnId. Forge resolves the latest valid report turn in this session."),
  candidateSessionIds: z.tuple([opaqueId, opaqueId]).optional().describe("Legacy form of candidateTurnIds. Forge resolves the latest valid report turn in each session."),
}).strict();
const plannedNeedsPlan = (assignment: { mode?: "planned" | "direct" | undefined; plan?: string | undefined }) => assignment.mode === "direct" || (assignment.plan?.length ?? 0) > 0;
export const WorkerAssignmentSchema = WorkerAssignmentShape.refine(plannedNeedsPlan, "A planned assignment requires the Coordinator's plan");
export type WorkerAssignment = z.infer<typeof WorkerAssignmentSchema>;

export const AdvisorRequestSchema = z.object({
  role: AdvisorRoleSchema,
  brief: z.string().trim().min(1).max(20_000).optional().describe("Reviewer only: Coordinator's plan and acceptance criteria. Forge composes every other Advisor input."), // bound: 20,000 characters keeps the brief inside one native prompt
}).strict();
export type AdvisorRequest = z.infer<typeof AdvisorRequestSchema>;

export const RootToolSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("observe") }).strict(),
  z.object({ kind: z.literal("read_image"), artifactId: opaqueId }).strict(),
  WorkerAssignmentShape.extend({ kind: z.literal("delegate_worker") }).strict().refine(plannedNeedsPlan, "A planned assignment requires the Coordinator's plan"),
  AdvisorRequestSchema.extend({ kind: z.literal("delegate_advisor") }).strict(),
  z.object({ kind: z.literal("request_delivery"), operation: DeliveryOperationSchema, expectedHead: z.string().min(1).optional(), review: DeliveryReviewSchema.optional(), pullRequestTitle: PullRequestTitleSchema.optional().describe("For pull request creation, use concise action-oriented wording based on the final reviewed diff. Do not copy task prose or a commit message.") }).strict(),
  z.object({ kind: z.literal("ask_human"), question: z.string().min(1), options: RecommendedQuestionOptionsSchema }).strict(),
]);

export type RootTool = z.infer<typeof RootToolSchema>;

/** Anthropic rejects a top-level oneOf in tool input, so the tool advertises one flat object; RootToolSchema still validates every call. */
export function rootToolInputSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const kinds: string[] = [];
  const guide: string[] = [];
  for (const variant of RootToolSchema.options) {
    const schema = z.toJSONSchema(variant) as { properties?: Record<string, Record<string, unknown>> };
    const fields = Object.keys(schema.properties ?? {}).filter(name => name !== "kind");
    kinds.push(String(schema.properties?.kind?.const));
    guide.push(`${String(schema.properties?.kind?.const)}: ${fields.join(", ") || "no other fields"}`);
    for (const name of fields) properties[name] ??= schema.properties?.[name];
  }
  return { type: "object", properties: { kind: { type: "string", enum: kinds, description: `The request kind. Fields per kind. ${guide.join(". ")}.` }, ...properties }, required: ["kind"], additionalProperties: false };
}

export const RootImageResultSchema = z.object({ kind: z.literal("image"), filename: z.string(), mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]), data: z.string() }).strict();
export type RootImageResult = z.infer<typeof RootImageResultSchema>;

export const RootBridgeConfigSchema = z.object({
  version: z.literal(1),
  root: RootIdentitySchema,
  databasePath: z.string().min(1).optional(),
  artifactRoot: z.string().min(1),
  server: z.object({ command: z.string().min(1), args: z.array(z.string()) }).strict(),
}).strict();

export type RootBridgeConfig = z.infer<typeof RootBridgeConfigSchema>;
