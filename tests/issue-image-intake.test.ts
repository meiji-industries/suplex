import { afterEach, expect, test, vi } from "vitest";
import { IssueTracker } from "../src/integrations/issue-tracker.js";

afterEach(() => vi.unstubAllEnvs());
test("Jira imports bounded verified images and leaves unsupported attachments as references", async () => {
  vi.stubEnv("TEST_EMAIL", "test@example.com");
  vi.stubEnv("TEST_TOKEN", "test-token");
  const connection = { kind: "jira" as const, site: "https://example.atlassian.net", project: "APP", emailEnvironment: "TEST_EMAIL", tokenEnvironment: "TEST_TOKEN" };
  const issue = { kind: "jira" as const, site: connection.site, id: "42", key: "APP-42", title: "Fix", url: `${connection.site}/browse/APP-42` };
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const request = vi.fn<typeof fetch>(async url => {
    if (String(url).includes("/attachment/content/")) return new Response(png);
    return Response.json({ id: "42", key: "APP-43", fields: { summary: "Fix", attachment: [
      { id: "1", filename: "../before.png", size: 8, mimeType: "image/png" },
      { id: "2", filename: "after.png", size: 8, mimeType: "image/png" },
      { id: "3", filename: "details.pdf", size: 8, mimeType: "application/pdf" },
    ] } });
  });
  const result = await new IssueTracker(connection, request).images(issue, 1);
  expect(result.images).toEqual([{ filename: ".._before.png", mimeType: "image/png", bytes: Buffer.from(png) }]);
  expect(result.notes.join(" ")).toContain("after.png was not loaded");
  expect(request).toHaveBeenCalledTimes(2);
  expect(String(request.mock.calls[1]?.[0])).toContain("redirect=false");
});
