import { z } from "zod";

export const AuthUserResponseSchema = z.object({ id: z.string(), displayName: z.string(), title: z.string(), username: z.string(), avatarSeed: z.string(), role: z.enum(["admin", "member"]), status: z.enum(["pending", "active", "revoked"]), companyIds: z.array(z.string()), readCompanyIds: z.array(z.string()).optional() });

// `plan` is a display label from local data, present on the company list only. Null means Suplex has no recent plan.
export const CompanyResponseSchema = z.object({ id: z.string(), name: z.string(), status: z.enum(["active", "paused", "archived"]), issueCode: z.string().nullable(), createdAt: z.string(), plan: z.enum(["free", "pro", "team"]).nullable().optional(), access: z.enum(["edit", "read"]).optional(), teamLapsed: z.boolean().optional() });

export type AuthUserResponse = z.infer<typeof AuthUserResponseSchema>;

export type CompanyResponse = z.infer<typeof CompanyResponseSchema>;

