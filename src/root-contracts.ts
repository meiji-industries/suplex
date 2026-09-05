import { z } from "zod";
import { RecommendedQuestionOptionsSchema } from "./human-question.js";

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
}).strict();
export type DeliveryReview = z.infer<typeof DeliveryReviewSchema>;

export const RootToolSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("observe") }).strict(),
  z.object({ kind: z.literal("read_image"), artifactId: opaqueId }).strict(),
  z.object({ kind: z.literal("delegate_worker"), instruction: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("request_delivery"), operation: DeliveryOperationSchema, expectedHead: z.string().min(1).optional(), review: DeliveryReviewSchema.optional() }).strict(),
  z.object({ kind: z.literal("ask_human"), question: z.string().min(1), options: RecommendedQuestionOptionsSchema }).strict(),
]);

export type RootTool = z.infer<typeof RootToolSchema>;

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
