import { expect, test } from "vitest";
import { checkGithubAuthentication } from "../src/profiles/provider-readiness.js";

test("GitHub readiness parses bounded JSON without exposing account details", async () => {
  const calls: string[][] = [];
  const check = checkGithubAuthentication("gh", async (_command, args, options) => {
    calls.push(args);
    expect(options).toMatchObject({ timeout: 3000, maxBuffer: 16384 });
    return {
      stdout: JSON.stringify({ hosts: { "github.com": [{ state: "success", active: true, login: "private-login" }] } }),
      stderr: "",
    };
  });
  const result = await check();
  expect(result.details).toMatchObject({ command: "gh", authentication: "available", failure: "none" });
  expect(calls).toEqual([["auth", "status", "--json", "hosts"]]);
  expect(JSON.stringify(result)).not.toContain("private-login");
});

test.each([
  ["missing", Object.assign(new Error("secret-path"), { code: "ENOENT" }), "command-missing"],
  ["timeout", new Error("gh timed out with secret-token"), "auth-timeout"],
  ["failed", new Error("secret-token"), "auth-failed"],
])("GitHub readiness redacts %s failures", async (_name, error, failure) => {
  const result = await checkGithubAuthentication("/private/bin/gh", async () => { throw error; })();
  expect(result.status).toBe("unhealthy");
  expect(result.details.failure).toBe(failure);
  expect(result.remedy).toBe(failure === "command-missing" ? "brew install gh" : "gh auth login");
  expect(JSON.stringify(result)).not.toMatch(/secret|private/);
});
