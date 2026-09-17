import { z } from "zod";

export const IssueAssociationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github"), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int().positive(), id: z.string(), key: z.string(), title: z.string(), url: z.string().url().refine(value => new URL(value).origin === "https://github.com") }).strict(),
  z.object({ kind: z.literal("jira"), site: z.string().url(), id: z.string().regex(/^\d+$/), key: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/), title: z.string(), url: z.string().url() }).strict(),
]).superRefine((issue, context) => {
  const url = new URL(issue.url);
  const expected = issue.kind === "github" ? `https://github.com/${issue.repository}/issues/${issue.number}` : `${new URL(issue.site).origin}/browse/${issue.key}`;
  if ((issue.kind === "github" ? url.href.toLowerCase() !== expected.toLowerCase() : url.href !== expected) || url.username || url.password) context.addIssue({ code: "custom", message: "Issue URL must match its tracker identity", path: ["url"] });
  if (issue.kind === "jira") {
    const site = new URL(issue.site);
    if (site.protocol !== "https:" || !site.hostname.endsWith(".atlassian.net") || site.username || site.password || site.search || site.hash || site.pathname !== "/") context.addIssue({ code: "custom", message: "Use a Jira Cloud site", path: ["site"] });
  }
});
export type IssueAssociation = z.infer<typeof IssueAssociationSchema>;
export const IssueContextSchema = z.object({ issue: IssueAssociationSchema, text: z.string(), capturedAt: z.string().datetime() });
export type IssueContext = z.infer<typeof IssueContextSchema>;
