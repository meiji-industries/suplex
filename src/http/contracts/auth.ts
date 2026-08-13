import { z } from "zod";

export const CompanyNameBodySchema = z.object({ name: z.string().default("") });
export const CompanyIssueCodeBodySchema = z.object({ issueCode: z.string().nullable() });
export const DisplayNameBodySchema = z.object({ displayName: z.string().default("") });
export const ProfileBodySchema = z.object({ displayName: z.string().optional(), username: z.string().optional(), avatarSeed: z.string().optional() }).refine((value) => value.displayName !== undefined || value.username !== undefined || value.avatarSeed !== undefined);
export const MembershipBodySchema = z.object({ userId: z.string().default("") });
