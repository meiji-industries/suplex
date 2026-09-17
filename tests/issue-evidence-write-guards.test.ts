import { createHash } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { IssueTracker } from "../src/integrations/issue-tracker.js";
import { BitbucketClient } from "../src/integrations/bitbucket.js";

afterEach(() => vi.unstubAllEnvs());
const connection = { kind: "jira" as const, site: "https://example.atlassian.net", project: "APP", emailEnvironment: "TEST_EMAIL", tokenEnvironment: "TEST_TOKEN" };
const issue = { kind: "jira" as const, site: connection.site, id: "42", key: "APP-42", title: "Fix", url: `${connection.site}/browse/APP-42` };
const credentials = () => { vi.stubEnv("TEST_EMAIL", "test@example.com"); vi.stubEnv("TEST_TOKEN", "test-token"); };

test.each(["publish", "upload"])("Jira %s checks cancellation after remote discovery", async action => {
  credentials();
  const request = vi.fn<typeof fetch>(async url => {
    const path = String(url);
    if (path.endsWith("/myself")) return Response.json({ accountId: "forge" });
    if (path.includes("/comment")) return Response.json({ comments: [], total: 0, startAt: 0 });
    return Response.json({ id: "42", key: "APP-43", fields: { summary: "Fix", attachment: [] } });
  });
  const tracker = new IssueTracker(connection, request);
  const beforeWrite = vi.fn(async () => { throw new Error("cancelled"); });
  const bytes = Buffer.from("image");
  const filename = `forge-task-${createHash("sha256").update(bytes).digest("hex")}.png`;
  await expect(action === "publish" ? tracker.publish(issue, "task", "Evidence", beforeWrite) : tracker.upload(issue, filename, bytes, "image/png", beforeWrite)).rejects.toThrow("cancelled");
  expect(beforeWrite).toHaveBeenCalledOnce();
  expect(request.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});

test("Jira refuses publication after the issue moves outside the configured project", async () => {
  credentials();
  const request = vi.fn<typeof fetch>(async url => {
    const path = String(url);
    if (path.endsWith("/myself")) return Response.json({ accountId: "forge" });
    if (path.includes("/comment")) return Response.json({ comments: [], total: 0, startAt: 0 });
    return Response.json({ id: "42", key: "OTHER-42", fields: { summary: "Fix" } });
  });
  await expect(new IssueTracker(connection, request).publish(issue, "task", "Evidence")).rejects.toThrow("configured tracker");
  expect(request.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});

test("Bitbucket checks cancellation after download discovery", async () => {
  credentials();
  const request = vi.fn<typeof fetch>(async () => Response.json({ values: [] }));
  const client = new BitbucketClient({ kind: "bitbucket", tokenEnvironment: "TEST_TOKEN" }, request);
  await expect(client.upload("owner/repo", "forge-task.png", Buffer.from("image"), "image/png", async () => { throw new Error("cancelled"); })).rejects.toThrow("cancelled");
  expect(request).toHaveBeenCalledOnce();
});
