import { z } from "zod";

const environmentReference = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);

export const RepositoryConnectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github") }).strict(),
  z.object({ kind: z.literal("bitbucket"), tokenEnvironment: environmentReference, usernameEnvironment: environmentReference.optional() }).strict(),
]);

export const TrackerConnectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github"), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }).strict(),
  z.object({ kind: z.literal("jira"), site: z.string().url().refine(value => { const url = new URL(value); return url.protocol === "https:" && /^[a-z0-9-]+\.atlassian\.net$/.test(url.hostname) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash; }), project: z.string().regex(/^[A-Z][A-Z0-9_]*$/), emailEnvironment: environmentReference, tokenEnvironment: environmentReference }).strict(),
  z.object({ kind: z.literal("linear"), team: z.string().regex(/^[A-Z][A-Z0-9_]*$/), tokenEnvironment: environmentReference }).strict(),
]);

export const ProjectIntegrationSchema = z.object({
  repository: RepositoryConnectionSchema.default({ kind: "github" }),
  tracker: TrackerConnectionSchema.nullable().default(null),
}).strict();

export type ProjectIntegration = z.infer<typeof ProjectIntegrationSchema>;

export type RepositoryConnection = z.infer<typeof RepositoryConnectionSchema>;
