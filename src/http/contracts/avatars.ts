import { z } from "zod";
import { MAX_AVATAR_IMAGE_BASE64_LENGTH } from "../../identity/avatar-kinds.js";
import { IdSchema } from "./common.js";

export const AvatarShapeSchema = z.enum(["square", "circle"]);
export const AvatarRecordSchema = z.object({ shape: AvatarShapeSchema.nullable(), imageVersion: z.string().nullable() });
export const AvatarDirectoryResponseSchema = z.object({ avatars: z.record(z.string(), AvatarRecordSchema) });
export const AvatarOwnerParamsSchema = z.object({ ownerId: IdSchema });
export const AvatarImageBodySchema = z.object({ mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]), base64: z.string().min(1).max(MAX_AVATAR_IMAGE_BASE64_LENGTH) }).strict();
export const AvatarUpdateBodySchema = z.object({ shape: AvatarShapeSchema.nullable().optional(), image: AvatarImageBodySchema.nullable().optional() }).strict();

export type AvatarRecord = z.infer<typeof AvatarRecordSchema>;
export type AvatarUpdateBody = z.infer<typeof AvatarUpdateBodySchema>;
