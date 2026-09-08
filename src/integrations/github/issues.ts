import { z } from "zod";

export const GithubIssueSchema = z.object({
  number: z.number().int().positive(), url: z.string().url(), title: z.string(), body: z.string(),
  author: z.object({ login: z.string() }).nullable(), state: z.enum(["OPEN", "CLOSED"]),
  labels: z.array(z.object({ name: z.string() })), assignees: z.array(z.object({ login: z.string() })),
  milestone: z.object({ title: z.string() }).nullable(), updatedAt: z.string(),
});
export type GithubIssue = z.infer<typeof GithubIssueSchema>;
export const GithubIssueCommentSchema = z.object({
  html_url: z.string().url(), body: z.string(), user: z.object({ login: z.string() }).nullable(), created_at: z.string(),
});
export type GithubIssueDetails = GithubIssue & { comments: z.infer<typeof GithubIssueCommentSchema>[] };
export const issueFields = "number,url,title,body,author,state,labels,assignees,milestone,updatedAt";

export function issueContext(issue: GithubIssueDetails): string {
  return [
    `## GitHub issue #${issue.number}: ${issue.title}`, issue.url,
    `Author: ${issue.author?.login ?? "deleted user"} | State: ${issue.state} | Updated: ${issue.updatedAt}`,
    `Labels: ${issue.labels.map(label => label.name).join(", ") || "None"}`,
    `Assignees: ${issue.assignees.map(user => user.login).join(", ") || "None"}`,
    `Milestone: ${issue.milestone?.title ?? "None"}`, issue.body,
    ...issue.comments.map(comment => `### ${comment.user?.login ?? "deleted user"} · ${comment.created_at}\n${comment.html_url}\n\n${comment.body}`),
  ].join("\n\n");
}
