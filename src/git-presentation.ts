import { z } from "zod";

const branchSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isTrimmed(value: string): boolean {
  return value === value.trim();
}

export const GitPresentationSchema = z.object({
  branchSlug: z.string().min(2).max(48).regex(branchSlugPattern),
  pullRequestTitle: z.string().min(1).max(100).refine(isTrimmed, "Pull request titles must be trimmed"),
  pullRequestDescription: z.string().min(1).max(2_000).refine(isTrimmed, "Pull request descriptions must be trimmed"),
}).strict();

export type GitPresentation = z.infer<typeof GitPresentationSchema>;

function boundedWords(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const shortened = value.slice(0, limit + 1);
  const boundary = shortened.lastIndexOf(" ");
  return (boundary >= Math.floor(limit / 2) ? shortened.slice(0, boundary) : value.slice(0, limit)).trim();
}

export function branchSlugFromTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[’']/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug.length >= 2 ? slug : "change";
}

export function fallbackGitPresentation(taskTitle: string): GitPresentation {
  const title = boundedWords(taskTitle.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim(), 100) || "Update the project";
  const description = /[.!?]$/.test(title) ? title : `${title}.`;
  return GitPresentationSchema.parse({ branchSlug: branchSlugFromTitle(title), pullRequestTitle: title, pullRequestDescription: description });
}
