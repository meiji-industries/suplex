import { expect, test } from "vitest";
import { createGithubReleasePort, type GithubReleaseFailure } from "../src/github-delivery.js";
import { GithubTriggerInspectionChangedFailure } from "../src/github-trigger-inspection.js";

const sha = (letter: string) => letter.repeat(40);
const pull = (overrides: Record<string, unknown> = {}) => ({
  number: 7,
  html_url: "https://github.com/owner/repo/pull/7",
  state: "open",
  draft: false,
  changed_files: 1,
  labels: [{ name: "agent-ready" }],
  title: "Trigger candidate",
  head: { ref: "feature", sha: sha("a"), repo: { id: 2, full_name: "owner/repo" } },
  base: { ref: "main", sha: sha("b"), repo: { id: 2, full_name: "owner/repo" } },
  ...overrides,
});
const file = (overrides: Record<string, unknown> = {}) => ({
  sha: sha("c"),
  filename: "src/index.ts",
  status: "modified",
  additions: 1,
  deletions: 0,
  changes: 1,
  blob_url: "https://github.com/owner/repo/blob/a/src/index.ts",
  raw_url: "https://raw.githubusercontent.com/owner/repo/a/src/index.ts",
  contents_url: "https://api.github.com/repos/owner/repo/contents/src/index.ts",
  ...overrides,
});
const path = (args: string[]) => args.at(-1) ?? "";

test("observes immutable repository identity and validates an exact encoded label", async () => {
  const calls: string[][] = [];
  const port = createGithubReleasePort({ runner: async input => {
    calls.push(input.args);
    return { stdout: JSON.stringify(path(input.args).includes("/labels/") ? { name: "ready & safe" } : { id: 1, full_name: "Owner/Repo" }), stderr: "" };
  } });
  await expect(port.observeRepository({ repository: "Owner/Repo" })).resolves.toEqual({ id: 1, fullName: "owner/repo" });
  await expect(port.validateLabel({ repository: "owner/repo", label: "ready & safe" })).resolves.toBeUndefined();
  expect(calls).toEqual([["api", "--method", "GET", "repos/owner/repo"], ["api", "--method", "GET", "repos/owner/repo/labels/ready%20%26%20safe"]]);
});

test("rejects a label response that does not exactly match", async () => {
  const port = createGithubReleasePort({ runner: async () => ({ stdout: JSON.stringify({ name: "READY" }), stderr: "" }) });
  await expect(port.validateLabel({ repository: "owner/repo", label: "ready" })).rejects.toMatchObject({ code: "invalid-provider-response" } satisfies Partial<GithubReleaseFailure>);
});

test("enumerates every labelled issue page, retaining only pull requests", async () => {
  const calls: string[][] = [];
  const first = Array.from({ length: 100 }, (_, index) => ({ number: index + 1, pull_request: {} }));
  const port = createGithubReleasePort({ runner: async input => {
    calls.push(input.args);
    return { stdout: JSON.stringify(path(input.args).includes("&page=1") ? first : [{ number: 101, pull_request: {} }, { number: 102, pull_request: {} }, { number: 103 }]), stderr: "" };
  } });
  const candidates = await port.listOpenPullRequestsByLabel({ repository: "owner/repo", label: "agent ready" });
  expect(candidates).toHaveLength(102);
  expect(candidates.at(0)).toEqual({ number: 1 });
  expect(candidates.at(-1)).toEqual({ number: 102 });
  expect(calls).toEqual([
    ["api", "--method", "GET", "repos/owner/repo/issues?state=open&labels=agent%20ready&per_page=100&page=1"],
    ["api", "--method", "GET", "repos/owner/repo/issues?state=open&labels=agent%20ready&per_page=100&page=2"],
  ]);
});

test("later label pages fail the whole enumeration", async () => {
  const port = createGithubReleasePort({ runner: async input => {
    if (path(input.args).includes("&page=2")) throw Object.assign(new Error("down"), { stderr: "connection refused" });
    return { stdout: JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ number: index + 1, pull_request: {} }))), stderr: "" };
  } });
  await expect(port.listOpenPullRequestsByLabel({ repository: "owner/repo", label: "ready" })).rejects.toThrow("connection refused");
});

test("rejects duplicate and malformed labelled issue pages", async () => {
  const duplicate = createGithubReleasePort({ runner: async input => ({ stdout: JSON.stringify(path(input.args).includes("page=1") ? Array.from({ length: 100 }, (_, index) => ({ number: index + 1, pull_request: {} })) : [{ number: 1, pull_request: {} }]), stderr: "" }) });
  await expect(duplicate.listOpenPullRequestsByLabel({ repository: "owner/repo", label: "ready" })).rejects.toMatchObject({ code: "invalid-provider-response" } satisfies Partial<GithubReleaseFailure>);
  const malformed = createGithubReleasePort({ runner: async () => ({ stdout: JSON.stringify([{ number: "seven", pull_request: {} }]), stderr: "" }) });
  await expect(malformed.listOpenPullRequestsByLabel({ repository: "owner/repo", label: "ready" })).rejects.toMatchObject({ code: "invalid-provider-response" } satisfies Partial<GithubReleaseFailure>);
});

test("inspects complete file metadata and rechecks the pull request revision", async () => {
  let pullRequests = 0;
  const port = createGithubReleasePort({ runner: async input => {
    if (path(input.args).includes("/files?")) return { stdout: JSON.stringify([file({ status: "renamed", filename: "src/new.ts", previous_filename: "src/old.ts" })]), stderr: "" };
    pullRequests += 1;
    return { stdout: JSON.stringify(pull()), stderr: "" };
  } });
  const inspected = await port.inspectPullRequest({ repository: "owner/repo", number: 7 });
  expect(pullRequests).toBe(2);
  expect(inspected).toMatchObject({ title: "Trigger candidate", headBranch: "feature", changedFiles: 1, isCrossRepository: false, files: [{ filename: "src/new.ts", previousFilename: "src/old.ts", status: "renamed" }] });
});

test("paginates files above 100 and stops at exactly 3000", async () => {
  const responses = (count: number) => {
    const calls: string[] = [];
    const port = createGithubReleasePort({ runner: async input => {
      const request = path(input.args);
      calls.push(request);
      if (!request.includes("/files?")) return { stdout: JSON.stringify(pull({ changed_files: count })), stderr: "" };
      const page = Number(new URL(`https://example.test/${request}`).searchParams.get("page"));
      const start = (page - 1) * 100;
      return { stdout: JSON.stringify(Array.from({ length: Math.min(100, Math.max(0, count - start)) }, (_, index) => file({ filename: `src/${start + index}.ts` }))), stderr: "" };
    } });
    return { port, calls };
  };
  const aboveOneHundred = responses(101);
  await expect(aboveOneHundred.port.inspectPullRequest({ repository: "owner/repo", number: 7 })).resolves.toMatchObject({ changedFiles: 101 });
  expect(aboveOneHundred.calls.filter(call => call.includes("/files?")).length).toBe(2);
  const maximum = responses(3000);
  await expect(maximum.port.inspectPullRequest({ repository: "owner/repo", number: 7 })).resolves.toMatchObject({ changedFiles: 3000 });
  expect(maximum.calls.filter(call => call.includes("/files?")).length).toBe(30);
  expect(maximum.calls.some(call => call.includes("page=31"))).toBe(false);
});

test("rejects incomplete file lists, malformed rename data, and revisions that change during inspection", async () => {
  const incomplete = createGithubReleasePort({ runner: async input => ({ stdout: JSON.stringify(path(input.args).includes("/files?") ? [] : pull()), stderr: "" }) });
  await expect(incomplete.inspectPullRequest({ repository: "owner/repo", number: 7 })).rejects.toMatchObject({ code: "invalid-provider-response" } satisfies Partial<GithubReleaseFailure>);

  const malformedRename = createGithubReleasePort({ runner: async input => ({ stdout: JSON.stringify(path(input.args).includes("/files?") ? [file({ status: "renamed" })] : pull()), stderr: "" }) });
  await expect(malformedRename.inspectPullRequest({ repository: "owner/repo", number: 7 })).rejects.toMatchObject({ code: "invalid-provider-response" } satisfies Partial<GithubReleaseFailure>);

  let reads = 0;
  const changed = createGithubReleasePort({ runner: async input => {
    if (path(input.args).includes("/files?")) return { stdout: JSON.stringify([file()]), stderr: "" };
    reads += 1;
    return { stdout: JSON.stringify(pull(reads === 2 ? { head: { ref: "feature", sha: sha("d"), repo: { id: 2, full_name: "owner/repo" } } } : {})), stderr: "" };
  } });
  await expect(changed.inspectPullRequest({ repository: "owner/repo", number: 7 })).rejects.toBeInstanceOf(GithubTriggerInspectionChangedFailure);
});

test("rejects unsafe file data, limits, duplicate pages, and later page failures", async () => {
  const tooMany = createGithubReleasePort({ runner: async () => ({ stdout: JSON.stringify(pull({ changed_files: 3001 })), stderr: "" }) });
  await expect(tooMany.inspectPullRequest({ repository: "owner/repo", number: 7 })).rejects.toMatchObject({ code: "invalid-provider-response" } satisfies Partial<GithubReleaseFailure>);

  const duplicate = createGithubReleasePort({ runner: async input => ({ stdout: JSON.stringify(path(input.args).includes("/files?") ? [file(), file()] : pull({ changed_files: 2 })), stderr: "" }) });
  await expect(duplicate.inspectPullRequest({ repository: "owner/repo", number: 7 })).rejects.toMatchObject({ code: "invalid-provider-response" } satisfies Partial<GithubReleaseFailure>);

  const excess = createGithubReleasePort({ runner: async input => ({ stdout: JSON.stringify(path(input.args).includes("/files?") ? [file(), file({ filename: "src/other.ts" })] : pull()), stderr: "" }) });
  await expect(excess.inspectPullRequest({ repository: "owner/repo", number: 7 })).rejects.toMatchObject({ code: "invalid-provider-response" } satisfies Partial<GithubReleaseFailure>);

  const missingCount = createGithubReleasePort({ runner: async () => {
    const response = pull();
    delete (response as { changed_files?: number }).changed_files;
    return { stdout: JSON.stringify(response), stderr: "" };
  } });
  await expect(missingCount.inspectPullRequest({ repository: "owner/repo", number: 7 })).rejects.toMatchObject({ code: "invalid-provider-response" } satisfies Partial<GithubReleaseFailure>);

  const laterFailure = createGithubReleasePort({ runner: async input => {
    if (path(input.args).includes("page=2")) throw Object.assign(new Error("offline"), { stderr: "connection refused" });
    return { stdout: JSON.stringify(path(input.args).includes("/files?") ? Array.from({ length: 100 }, (_, index) => file({ filename: `src/${index}.ts` })) : pull({ changed_files: 101 })), stderr: "" };
  } });
  await expect(laterFailure.inspectPullRequest({ repository: "owner/repo", number: 7 })).rejects.toThrow("connection refused");

  const invalidJson = createGithubReleasePort({ runner: async () => ({ stdout: "not json", stderr: "" }) });
  await expect(invalidJson.inspectPullRequest({ repository: "owner/repo", number: 7 })).rejects.toMatchObject({ code: "invalid-provider-response" } satisfies Partial<GithubReleaseFailure>);
});

test("rechecks requested identity and returns final pull metadata", async () => {
  for (const change of [
    { number: 8 },
    { base: { ref: "main", sha: sha("b"), repo: { id: 2, full_name: "other/repo" } } },
    { base: { ref: "release", sha: sha("b"), repo: { id: 2, full_name: "owner/repo" } } },
    { base: { ref: "main", sha: sha("d"), repo: { id: 2, full_name: "owner/repo" } } },
    { head: { ref: "feature", sha: sha("d"), repo: { id: 2, full_name: "owner/repo" } } },
    { head: { ref: "feature", sha: sha("a"), repo: { id: 3, full_name: "fork/repo" } } },
    { base: { ref: "main", sha: sha("b"), repo: { id: 3, full_name: "owner/repo" } } },
  ]) {
    let reads = 0;
    const port = createGithubReleasePort({ runner: async input => {
      if (path(input.args).includes("/files?")) return { stdout: JSON.stringify([file()]), stderr: "" };
      reads += 1;
      return { stdout: JSON.stringify(pull(reads === 2 ? change : {})), stderr: "" };
    } });
    await expect(port.inspectPullRequest({ repository: "owner/repo", number: 7 })).rejects.toThrow();
  }

  let reads = 0;
  const finalMetadata = createGithubReleasePort({ runner: async input => {
    if (path(input.args).includes("/files?")) return { stdout: JSON.stringify([file({ status: "removed", filename: "src/deleted.ts" })]), stderr: "" };
    reads += 1;
    return { stdout: JSON.stringify(pull(reads === 2 ? { state: "closed", draft: true, labels: [], title: "Closed now" } : {})), stderr: "" };
  } });
  await expect(finalMetadata.inspectPullRequest({ repository: "owner/repo", number: 7 })).resolves.toMatchObject({ state: "closed", isDraft: true, labels: [], title: "Closed now", files: [{ status: "removed" }] });
});

test("trigger provider failures retain classification but redact summaries", async () => {
  const auth = createGithubReleasePort({ runner: async () => { throw Object.assign(new Error("auth"), { stderr: "GH_TOKEN=github_pat_secret_token" }); } });
  await expect(auth.validateLabel({ repository: "owner/repo", label: "ready" })).rejects.toMatchObject({ code: "authentication-required", summary: expect.not.stringContaining("github_pat_secret_token") });
  const rate = createGithubReleasePort({ runner: async input => {
    if (path(input.args) === "rate_limit") return { stdout: JSON.stringify({ resources: { core: { reset: Math.ceil(Date.now() / 1_000) + 60 } } }), stderr: "" };
    throw Object.assign(new Error("limited"), { stdout: JSON.stringify({ message: "rate github_pat_secret_token", documentation_url: "https://docs.github.com/rest", status: 429 }), stderr: "" });
  } });
  await expect(rate.validateLabel({ repository: "owner/repo", label: "ready" })).rejects.toMatchObject({ code: "provider-rate-limited", retryAt: expect.any(String), summary: expect.not.stringContaining("github_pat_secret_token") });
});
