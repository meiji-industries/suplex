import { afterEach, expect, test, vi } from "vitest";
import { IssueTracker } from "../src/integrations/issue-tracker.js";
import { BitbucketClient, createBitbucketReleasePort } from "../src/integrations/bitbucket.js";
import { ProjectIntegrationSchema } from "../src/projects/integration-configuration.js";

afterEach(() => vi.unstubAllEnvs());
const connection = { kind: "jira" as const, site: "https://example.atlassian.net", project: "APP", emailEnvironment: "TEST_JIRA_EMAIL", tokenEnvironment: "TEST_JIRA_TOKEN" };
const issue = { kind: "jira" as const, site: connection.site, id: "42", key: "APP-42", title: "Fix", url: `${connection.site}/browse/APP-42` };
const credentials = () => { vi.stubEnv("TEST_JIRA_EMAIL", "test@example.com"); vi.stubEnv("TEST_JIRA_TOKEN", "test-token"); vi.stubEnv("TEST_BB_TOKEN", "test-token"); };

test("Jira reads all comment pages and keeps custom field names", async () => {
  credentials();
  const request = vi.fn<typeof fetch>(async url => {
    const path = String(url);
    if (path.includes("/comment")) {
      const second = path.includes("startAt=1");
      return Response.json({ startAt: second ? 1 : 0, total: 2, comments: [{ id: second ? "2" : "1", body: { type: "doc", content: [{ type: "text", text: second ? "second" : "first" }] } }] });
    }
    return Response.json({ id: "42", key: "APP-42", names: { customfield_12: "Expected change" }, fields: { summary: "Fix", customfield_12: "Keep it working" } });
  });
  const result = await new IssueTracker(connection, request).read(issue);
  expect(result.text).toContain("Expected change: Keep it working");
  expect(result.text).toContain("first\n\nsecond");
  expect(request).toHaveBeenCalledTimes(3);
});

test("lost comment response is recovered by marker without another create", async () => {
  credentials();
  const body = "Evidence\n\n[Forge task task_one]";
  const request = vi.fn<typeof fetch>(async url => String(url).endsWith("/myself") ? Response.json({ accountId: "forge-user" }) : Response.json({ startAt: 0, total: 1, comments: [{ id: "9", body, author: { accountId: "forge-user" } }] }));
  expect(await new IssueTracker(connection, request).publish(issue, "task_one", "Evidence")).toBe("9");
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[0]?.[1]?.method ?? "GET").toBe("GET");
});

test("tracker rejects another site before credentials leave the host", async () => {
  const request = vi.fn<typeof fetch>();
  await expect(new IssueTracker(connection, request).read({ ...issue, site: "https://other.atlassian.net" })).rejects.toThrow("configured tracker");
  expect(request).not.toHaveBeenCalled();
  expect(ProjectIntegrationSchema.safeParse({ tracker: { ...connection, site: "https://attacker.example" } }).success).toBe(false);
});

test("Bitbucket creates a real draft at the explicit destination", async () => {
  credentials();
  const endpoint = (name: string) => ({ branch: { name }, commit: { hash: "a".repeat(40) }, repository: { full_name: "owner/repo" } });
  const request = vi.fn<typeof fetch>(async () => Response.json({ id: 7, title: "Fix", state: "OPEN", draft: true, source: endpoint("feature"), destination: endpoint("develop"), links: { html: { href: "https://bitbucket.org/owner/repo/pull-requests/7" } } }));
  const port = createBitbucketReleasePort({ kind: "bitbucket", tokenEnvironment: "TEST_BB_TOKEN" }, request);
  const result = await port.createDraftPullRequest({ repository: "owner/repo", owner: "owner", headBranch: "feature", baseBranch: "develop", title: "Fix", body: "Evidence" });
  expect(result.isDraft).toBe(true);
  expect(result.baseBranch).toBe("develop");
  expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({ draft: true, destination: { branch: { name: "develop" } } });
});

test("Bitbucket rejects a cross-origin pagination link without forwarding authentication", async () => {
  credentials();
  const request = vi.fn<typeof fetch>(async () => Response.json({ values: [], next: "https://attacker.example/collect" }));
  await expect(new BitbucketClient({ kind: "bitbucket", tokenEnvironment: "TEST_BB_TOKEN" }, request).list("owner/repo")).rejects.toThrow("unsafe URL");
  expect(request).toHaveBeenCalledTimes(1);
});

test("Bitbucket observes every check page rather than leaving a synthetic pending check", async () => {
  credentials();
  const endpoint = (name: string) => ({ branch: { name }, commit: { hash: "a".repeat(40) }, repository: { full_name: "owner/repo" } });
  const request = vi.fn<typeof fetch>(async url => {
    const path = String(url);
    if (path.includes("statuses")) return Response.json({ values: [{ name: path.includes("page=2") ? "second" : "first", state: "SUCCESSFUL" }], ...(path.includes("page=2") ? {} : { next: "https://api.bitbucket.org/2.0/repositories/owner/repo/commit/sha/statuses?page=2" }) });
    return Response.json({ id: 7, title: "Fix", state: "OPEN", draft: true, source: endpoint("feature"), destination: endpoint("develop"), links: { html: { href: "https://bitbucket.org/owner/repo/pull-requests/7" } } });
  });
  const result = await createBitbucketReleasePort({ kind: "bitbucket", tokenEnvironment: "TEST_BB_TOKEN" }, request).observePullRequest({ repository: "owner/repo", branch: "feature", pullRequestNumber: 7 });
  expect(result.checks).toMatchObject({ total: 2, pending: 0, successful: 2 });
  expect(request).toHaveBeenCalledTimes(3);
});
