import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { IssueTracker, issueText, jiraEvidenceDocument } from "../src/integrations/issue-tracker.js";
import { providerBytes } from "../src/integrations/provider-http.js";

afterEach(() => vi.unstubAllEnvs());
const jira = { kind: "jira" as const, site: "https://example.atlassian.net", project: "APP", emailEnvironment: "TEST_JIRA_EMAIL", tokenEnvironment: "TEST_JIRA_TOKEN" };
const issue = { kind: "jira" as const, site: jira.site, id: "42", key: "APP-42", title: "Fix", url: `${jira.site}/browse/APP-42` };
const githubIssue = { kind: "github" as const, repository: "owner/repo", id: "42", number: 42, key: "#42", title: "Fix", url: "https://github.com/owner/repo/issues/42" };
const bytes = Buffer.from("fixture-image");
const filename = `forge-task_one-${createHash("sha256").update(bytes).digest("hex")}.png`;
const credentials = () => { vi.stubEnv("TEST_JIRA_EMAIL", "test@example.com"); vi.stubEnv("TEST_JIRA_TOKEN", "fixture-token"); };

test("Jira evidence links stay clickable without changing read-back text", () => {
  const text = "Draft: https://github.com/owner/repo/pull/1\n\n![Before](https://example.atlassian.net/secure/attachment/7/before.png)";
  const document = jiraEvidenceDocument(text);
  expect(issueText(document)).toBe(text);
  expect(document.content[0]?.content[1]).toMatchObject({ text: "https://github.com/owner/repo/pull/1", marks: [{ type: "link", attrs: { href: "https://github.com/owner/repo/pull/1" } }] });
  expect(document.content[2]?.content[1]).toMatchObject({ marks: [{ type: "link", attrs: { href: "https://example.atlassian.net/secure/attachment/7/before.png" } }] });
});

test("Jira attachment response loss reuses owned, hash-verified remote attachment", async () => {
  credentials();
  let uploaded = false;
  let uploads = 0;
  const request = vi.fn<typeof fetch>(async (url, options) => {
    const path = String(url);
    if (path.endsWith("/myself")) return Response.json({ accountId: "me" });
    if (path.includes("?fields=summary")) return Response.json({ id: "42", key: "APP-42", fields: { summary: "Fix" } });
    if (path.includes("?fields=attachment")) return Response.json({ fields: { attachment: uploaded ? [{ id: "7", filename, size: bytes.length, author: { accountId: "me" } }] : [] } });
    if (path.includes("/attachment/content/7")) return new Response(bytes);
    expect(options?.headers).toMatchObject({ "X-Atlassian-Token": "no-check" });
    expect(options?.body).toBeInstanceOf(FormData);
    uploaded = true;
    uploads++;
    throw new Error("Response lost after upload");
  });
  const tracker = new IssueTracker(jira, request);
  await expect(tracker.upload(issue, filename, bytes, "image/png")).rejects.toThrow("Response lost");
  expect(await tracker.upload(issue, filename, bytes, "image/png")).toBe(`${jira.site}/secure/attachment/7/${filename}`);
  expect(uploads).toBe(1);
});

test("GitHub media uses supported CLI and recovers its owned comment after response loss", async () => {
  let body: string | null = null;
  let uploads = 0;
  const github = async (path: string) => path === "user" ? { id: 4 } : body ? [{ id: 9, body, user: { id: 4 } }] : [];
  const command = async (args: string[]) => {
    if (args.includes("--help")) return { stdout: "--attach file", stderr: "" };
    uploads++;
    const file = args[args.indexOf("--body-file") + 1];
    if (!file) throw new Error("Body file missing");
    const suppliedBody = await readFile(file, "utf8");
    expect(suppliedBody).toBe(`[Forge attachment ${filename}]`);
    expect(args[args.indexOf("--attach") + 1]).toMatch(new RegExp(`${filename}$`));
    body = `${suppliedBody}\n\n![${filename}](https://github.com/user-attachments/assets/fixture)`;
    throw new Error("Response lost");
  };
  const tracker = new IssueTracker({ kind: "github", repository: "owner/repo" }, fetch, github, command);
  await expect(tracker.upload(githubIssue, filename, bytes, "image/png")).rejects.toThrow("Response lost");
  expect(await tracker.upload(githubIssue, filename, bytes, "image/png")).toBe("https://github.com/user-attachments/assets/fixture");
  expect(uploads).toBe(1);
});

test("GitHub media requests a CLI upgrade before uploading when --attach is absent", async () => {
  const github = async (path: string) => path === "user" ? { id: 4 } : [];
  const command = vi.fn(async () => ({ stdout: "--body-file file", stderr: "" }));
  const tracker = new IssueTracker({ kind: "github", repository: "owner/repo" }, fetch, github, command);
  await expect(tracker.upload(githubIssue, filename, bytes, "image/png")).rejects.toThrow("Update GitHub CLI");
  expect(command).toHaveBeenCalledExactlyOnceWith(["issue", "comment", "--help"]);
});

test("issue publication ignores another author's marker and confirms the new comment", async () => {
  let body = "other author's work\n\n[Forge task task_one]";
  let own = false;
  const calls: string[] = [];
  const github = async (path: string, input?: unknown, method?: string) => {
    calls.push(`${method ?? "GET"} ${path}`);
    if (path === "user") return { id: 4 };
    if (input) {
      if (typeof input !== "object" || !("body" in input) || typeof input.body !== "string") throw new Error("Invalid comment body");
      body = input.body; own = true; return { id: 9, body, user: { id: 4 } };
    }
    return [{ id: 9, body, user: { id: own ? 4 : 5 } }];
  };
  const tracker = new IssueTracker({ kind: "github", repository: "owner/repo" }, fetch, github);
  expect(await tracker.publish(githubIssue, "task_one", "Evidence")).toBe("9");
  expect(calls).toContain("POST repos/owner/repo/issues/42/comments");
  expect(calls.at(-1)).toContain("comments?per_page=100");
  expect(calls.some(call => call.startsWith("PATCH"))).toBe(false);
});

test("provider response limits apply while streaming and never send credentials to another origin", async () => {
  const request = vi.fn<typeof fetch>(async () => new Response("oversized"));
  await expect(providerBytes(new URL("https://api.example/data"), "https://api.example", "secret", {}, request, 3)).rejects.toThrow("too large");
  await expect(providerBytes(new URL("https://attacker.example/data"), "https://api.example", "secret", {}, request)).rejects.toThrow("unsafe URL");
  expect(request).toHaveBeenCalledTimes(1);
});

test("Jira intake reads bounded text attachments and linked context and reports binary gaps", async () => {
  credentials();
  const request = vi.fn<typeof fetch>(async url => {
    const path = String(url);
    if (path.includes("/comment")) return Response.json({ total: 0, startAt: 0, comments: [] });
    if (path.includes("/attachment/content/7")) return new Response("attached acceptance criteria");
    if (path.includes("/issue/99?")) return Response.json({ id: "99", key: "APP-99", fields: { summary: "Dependency", description: "Linked constraints" } });
    return Response.json({ id: "42", key: "APP-42", fields: { summary: "Fix", attachment: [{ id: "7", filename: "plan.txt", size: 20, mimeType: "text/plain" }, { id: "8", filename: "screen.png", size: 30, mimeType: "image/png" }], issuelinks: [{ outwardIssue: { id: "99", key: "APP-99" } }] } });
  });
  const context = await new IssueTracker(jira, request).read(issue);
  expect(context.text).toContain("attached acceptance criteria");
  expect(context.text).toContain("Linked constraints");
  expect(context.text).toContain("Content not loaded: binary");
});

test("publication requires matching remote content after the write", async () => {
  const github = async (path: string, input?: unknown) => path === "user" ? { id: 4 } : input ? { id: 9, body: "wrong", user: { id: 4 } } : [];
  await expect(new IssueTracker({ kind: "github", repository: "owner/repo" }, fetch, github).publish(githubIssue, "task_one", "Evidence")).rejects.toThrow("has not confirmed");
});

test.each([undefined, "missing", "9"])("evidence publication preserves own quoted markers and recovers with known ID %s", async knownId => {
  const quoted = "My note quotes [Forge task task_one] but is not Forge evidence";
  const previous = `## What changed\n\nOld summary\n\nSource: ${"a".repeat(40)}\n\n## Before\n\nFailed\n\n## After\n\nPassed\n\n## How to verify\n\nClick\n\n[Forge task task_one]`;
  const rows = [{ id: 8, body: quoted, user: { id: 4 } }, { id: 9, body: previous, user: { id: 4 } }];
  let writes = 0;
  const github = async (path: string, input?: unknown, method?: string) => {
    if (path === "user") return { id: 4 };
    if (input) {
      expect(path).toBe("repos/owner/repo/issues/comments/9");
      expect(method).toBe("PATCH");
      if (typeof input !== "object" || !("body" in input) || typeof input.body !== "string") throw new Error("Invalid body");
      rows[1]!.body = input.body;
      writes++;
      throw new Error("Response lost");
    }
    return rows;
  };
  const tracker = new IssueTracker({ kind: "github", repository: "owner/repo" }, fetch, github);
  await expect(tracker.publish(githubIssue, "task_one", "New evidence", undefined, knownId)).rejects.toThrow("Response lost");
  expect(await tracker.publish(githubIssue, "task_one", "New evidence", undefined, knownId)).toBe("9");
  expect(rows[0]?.body).toBe(quoted);
  expect(writes).toBe(1);
});

test("a known comment ID wins over an earlier evidence-shaped comment", async () => {
  const rows = [{ id: 8, body: "New evidence\n\n[Forge task task_one]", user: { id: 4 } }, { id: 9, body: "Edited known evidence", user: { id: 4 } }];
  const github = async (path: string, input?: unknown) => {
    if (path === "user") return { id: 4 };
    if (input) {
      expect(path).toBe("repos/owner/repo/issues/comments/9");
      rows[1]!.body = "New evidence\n\n[Forge task task_one]";
      return rows[1];
    }
    return rows;
  };
  expect(await new IssueTracker({ kind: "github", repository: "owner/repo" }, fetch, github).publish(githubIssue, "task_one", "New evidence", undefined, "9")).toBe("9");
});
