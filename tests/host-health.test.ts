import { expect, test } from "vitest";
import { checkGithubAuthentication } from "../src/profiles/provider-readiness.js";

test("GitHub readiness shows active authenticated users without exposing credentials", async () => {
  const calls: string[][] = [];
  const check = checkGithubAuthentication("gh", async (_command, args, options) => {
    calls.push(args);
    expect(options).toMatchObject({ timeout: 3000, maxBuffer: 16384 });
    return {
      stdout: JSON.stringify({ hosts: { "github.com": [
        { state: "success", active: true, login: "octocat", token: "secret-token", tokenSource: "keyring" },
        { state: "success", active: false, login: "inactive-user" },
        { state: "error", active: true, login: "failed-user" },
      ] } }),
      stderr: "",
    };
  });
  const result = await check();
  expect(result.details).toMatchObject({ command: "gh", authentication: "available", failure: "none", logins: "@octocat" });
  expect(calls).toEqual([["auth", "status", "--json", "hosts"]]);
  expect(result.status).toBe("healthy");
  expect(result.summary).toBe("GitHub CLI is installed. Signed in as @octocat (github.com).");
  expect(JSON.stringify(result)).not.toMatch(/secret-token|keyring|inactive-user|failed-user/);
});

test("an installed GitHub CLI without an active authenticated account needs sign-in", async () => {
  const result = await checkGithubAuthentication("gh", async () => ({
    stdout: JSON.stringify({ hosts: { "github.com": [{ state: "error", active: true, login: "octocat" }] } }), stderr: "",
  }))();
  expect(result).toMatchObject({ status: "unhealthy", remedy: "gh auth login", details: { failure: "unauthenticated" } });
  expect(result.summary).toBe("GitHub CLI is installed. Authentication is not available.");
  expect(result.summary).not.toContain("octocat");
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
