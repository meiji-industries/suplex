import { z } from "zod";

export const GitHubDeviceStartResponseSchema = z.object({
  flowId: z.string().uuid(),
  userCode: z.string().min(1),
  verificationUri: z.url(),
  expiresAt: z.string(),
  intervalSeconds: z.number().int().positive(),
}).strict();

export const GitHubDevicePollResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), nextPollAt: z.string() }).strict(),
  z.object({ status: z.literal("connected"), login: z.string().min(1) }).strict(),
  z.object({ status: z.literal("expired") }).strict(),
  z.object({ status: z.literal("denied") }).strict(),
]);

export const GitHubAuthStatusResponseSchema = z.discriminatedUnion("status", [
  z.object({ method: z.literal("device"), source: z.enum(["suplex", "gh", "none"]), status: z.literal("connected"), login: z.string().min(1) }).strict(),
  z.object({ method: z.literal("device"), source: z.enum(["suplex", "gh", "none"]), status: z.enum(["sign_in_required", "unavailable"]) }).strict(),
]);

export type GitHubDeviceStartResponse = z.infer<typeof GitHubDeviceStartResponseSchema>;

export type GitHubDevicePollResponse = z.infer<typeof GitHubDevicePollResponseSchema>;
