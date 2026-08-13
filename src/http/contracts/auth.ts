import { z } from "zod";

export const CompanyNameBodySchema = z.object({ name: z.string().default("") });
export const CompanyIssueCodeBodySchema = z.object({ issueCode: z.string().nullable() });
export const DisplayNameBodySchema = z.object({ displayName: z.string().default("") });
export const MembershipBodySchema = z.object({ userId: z.string().default("") });
