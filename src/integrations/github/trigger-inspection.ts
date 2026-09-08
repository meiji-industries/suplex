import { z } from "zod";

import { GithubReleaseFailure } from "./failure.js";
import { GithubTriggerPathError, validateGithubTriggerRepositoryFilename } from "./trigger-paths.js";

const shaPattern = /^[a-f0-9]{40,64}$/i;
const repositoryPattern = /^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9][a-z0-9_.-]{0,99}$/i;
const RepositorySchema = z.string().regex(repositoryPattern).transform(value => value.toLowerCase());
const PullDetailSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  changed_files: z.number().int().nonnegative(),
  labels: z.array(z.object({ name: z.string().min(1) })),
  title: z.string(),
  head: z.object({ ref: z.string().min(1), sha: z.string().regex(shaPattern), repo: z.object({ id: z.number().int().positive(), full_name: RepositorySchema }).nullable() }),
  base: z.object({ ref: z.string().min(1), sha: z.string().regex(shaPattern), repo: z.object({ id: z.number().int().positive(), full_name: RepositorySchema }) }),
});
const IssueSchema = z.object({ number: z.number().int().positive(), pull_request: z.object({}).optional() });
const FileSchema = z.object({
  sha: z.string().min(1),
  filename: z.string().min(1),
  status: z.enum(["added", "modified", "removed", "renamed", "copied", "changed", "unchanged"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
  blob_url: z.string().url(),
  raw_url: z.string().url(),
  contents_url: z.string().url(),
  previous_filename: z.string().min(1).optional(),
});

export interface GithubTriggerRepository {
  id: number;
  fullName: string;
}

export interface GithubTriggerCandidate {
  number: number;
}

export interface GithubTriggerFile {
  sha: string;
  filename: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  changes: number;
  blobUrl: string;
  rawUrl: string;
  contentsUrl: string;
  previousFilename: string | null;
}

export interface GithubTriggerPullRequestInspection {
  number: number;
  url: string;
  title: string;
  state: "open" | "closed";
  isDraft: boolean;
  labels: string[];
  changedFiles: number;
  headSha: string;
  headBranch: string;
  baseSha: string;
  baseBranch: string;
  headRepository: GithubTriggerRepository | null;
  baseRepository: GithubTriggerRepository;
  isCrossRepository: boolean;
  files: GithubTriggerFile[];
}

export class GithubTriggerInspectionChangedFailure extends Error {
  readonly code = "inspection-changed";

  constructor() {
    super("Pull request changed while its files were inspected");
    this.name = "GithubTriggerInspectionChangedFailure";
  }
}

export interface GithubTriggerPort {
  observeRepository(input: { repository: string }): Promise<GithubTriggerRepository>;
  validateLabel(input: { repository: string; label: string }): Promise<void>;
  listOpenPullRequestsByLabel(input: { repository: string; label: string }): Promise<GithubTriggerCandidate[]>;
  inspectPullRequest(input: { repository: string; number: number }): Promise<GithubTriggerPullRequestInspection>;
}

export type GithubTriggerApi = (args: string[], operation: string) => Promise<unknown>;

function invalid(message: string): never {
  throw new GithubReleaseFailure("invalid-provider-response", `GitHub trigger response is malformed: ${message}`);
}

function repository(value: string): string {
  const parsed = RepositorySchema.safeParse(value);
  if (!parsed.success) invalid("repository");
  return parsed.data;
}

function pull(value: unknown) {
  const parsed = PullDetailSchema.safeParse(value);
  if (!parsed.success) invalid("pull request");
  if (parsed.data.changed_files > 3000) invalid("pull request has more than 3000 changed files");
  return parsed.data;
}

function stable(a: z.infer<typeof PullDetailSchema>, b: z.infer<typeof PullDetailSchema>): boolean {
  return a.number === b.number
    && a.base.repo.full_name === b.base.repo.full_name
    && a.head.sha === b.head.sha
    && a.base.sha === b.base.sha
    && a.changed_files === b.changed_files
    && a.head.ref === b.head.ref
    && a.base.ref === b.base.ref
    && a.head.repo?.id === b.head.repo?.id
    && a.base.repo.id === b.base.repo.id;
}

function file(value: unknown): GithubTriggerFile {
  const parsed = FileSchema.safeParse(value);
  if (!parsed.success) invalid("pull request file");
  const row = parsed.data;
  try { validateGithubTriggerRepositoryFilename(row.filename); } catch (error) {
    if (error instanceof GithubTriggerPathError) invalid("pull request filename");
    throw error;
  }
  if (row.status === "renamed" ? row.previous_filename === undefined : row.previous_filename !== undefined) invalid("pull request rename metadata");
  if (row.previous_filename !== undefined) {
    try { validateGithubTriggerRepositoryFilename(row.previous_filename); } catch (error) {
      if (error instanceof GithubTriggerPathError) invalid("previous pull request filename");
      throw error;
    }
  }
  return { sha: row.sha, filename: row.filename, status: row.status, additions: row.additions, deletions: row.deletions, changes: row.changes, blobUrl: row.blob_url, rawUrl: row.raw_url, contentsUrl: row.contents_url, previousFilename: row.previous_filename ?? null };
}

export function createGithubTriggerPort(api: GithubTriggerApi): GithubTriggerPort {
  return {
    async observeRepository(input) {
      const value = await api(["api", "--method", "GET", `repos/${repository(input.repository)}`], "repository trigger observation");
      const parsed = z.object({ id: z.number().int().positive(), full_name: RepositorySchema }).safeParse(value);
      if (!parsed.success) invalid("repository identity");
      return { id: parsed.data.id, fullName: parsed.data.full_name };
    },
    async validateLabel(input) {
      if (!input.label || input.label.length > 100) invalid("label");
      const value = await api(["api", "--method", "GET", `repos/${repository(input.repository)}/labels/${encodeURIComponent(input.label)}`], "repository label validation");
      const parsed = z.object({ name: z.string().min(1) }).safeParse(value);
      if (!parsed.success || parsed.data.name !== input.label) invalid("repository label");
    },
    async listOpenPullRequestsByLabel(input) {
      if (!input.label || input.label.length > 100) invalid("label");
      const candidates: GithubTriggerCandidate[] = [];
      const seen = new Set<number>();
      for (let page = 1; ; page += 1) {
        const query = `state=open&labels=${encodeURIComponent(input.label)}&per_page=100&page=${page}`;
        const value = await api(["api", "--method", "GET", `repos/${repository(input.repository)}/issues?${query}`], "labelled pull request enumeration");
        const parsed = z.array(IssueSchema).max(100).safeParse(value);
        if (!parsed.success) invalid("labelled issue page");
        for (const issue of parsed.data) {
          if (seen.has(issue.number)) invalid("duplicate labelled issue page");
          seen.add(issue.number);
          if (issue.pull_request !== undefined) candidates.push({ number: issue.number });
        }
        if (parsed.data.length < 100) return candidates;
      }
    },
    async inspectPullRequest(input) {
      const repo = repository(input.repository);
      if (!Number.isSafeInteger(input.number) || input.number <= 0) invalid("pull request number");
      const before = pull(await api(["api", "--method", "GET", `repos/${repo}/pulls/${input.number}`], "pull request trigger inspection"));
      if (before.number !== input.number || before.base.repo.full_name !== repo) invalid("pull request identity");
      const files: GithubTriggerFile[] = [];
      const seen = new Set<string>();
      for (let page = 1; ; page += 1) {
        const value = await api(["api", "--method", "GET", `repos/${repo}/pulls/${input.number}/files?per_page=100&page=${page}`], "pull request file inspection");
        const parsed = z.array(FileSchema).max(100).safeParse(value);
        if (!parsed.success) invalid("pull request file page");
        for (const row of parsed.data) {
          const inspected = file(row);
          if (seen.has(inspected.filename)) invalid("duplicate pull request filename");
          seen.add(inspected.filename);
          files.push(inspected);
          if (files.length > before.changed_files) invalid("pull request file count");
        }
        if (files.length === before.changed_files || parsed.data.length < 100) break;
      }
      if (files.length !== before.changed_files) invalid("incomplete pull request file list");
      const after = pull(await api(["api", "--method", "GET", `repos/${repo}/pulls/${input.number}`], "pull request trigger recheck"));
      if (after.number !== input.number || after.base.repo.full_name !== repo) invalid("pull request identity");
      if (!stable(before, after)) throw new GithubTriggerInspectionChangedFailure();
      const headRepository = after.head.repo && { id: after.head.repo.id, fullName: after.head.repo.full_name };
      const baseRepository = { id: after.base.repo.id, fullName: after.base.repo.full_name };
      return { number: after.number, url: after.html_url, title: after.title, state: after.state, isDraft: after.draft, labels: after.labels.map(label => label.name), changedFiles: after.changed_files, headSha: after.head.sha, headBranch: after.head.ref, baseSha: after.base.sha, baseBranch: after.base.ref, headRepository, baseRepository, isCrossRepository: headRepository === null || headRepository.id !== baseRepository.id, files };
    },
  };
}
