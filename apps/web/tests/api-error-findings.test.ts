// @vitest-environment happy-dom
import { expect, test, vi } from "vitest";

import { ApiError, readJson } from "../lib/api.js";

test("API errors preserve validated optional finding codes", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    error: "Repository provisioning failed",
    findings: [
      { code: "github-auth-unavailable", field: "repositoryName", message: "GitHub identity failed" },
      { field: "baseBranch", message: "Base branch is invalid" },
      { code: 403, field: "repository", message: "Malformed code" },
    ],
  }), { status: 422 })));

  const error = await readJson("/api/test").catch(reason => reason);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).findings).toEqual([
    { code: "github-auth-unavailable", field: "repositoryName", message: "GitHub identity failed" },
    { field: "baseBranch", message: "Base branch is invalid" },
  ]);
  vi.unstubAllGlobals();
});
