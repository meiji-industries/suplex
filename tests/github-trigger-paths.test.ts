import { expect, test } from "vitest";
import { GithubTriggerPathError, matchesGithubTriggerProtectedPaths, validateGithubTriggerProtectedPaths, validateGithubTriggerRepositoryFilename } from "../src/github-trigger-paths.js";

test("protected paths match exact files and case-sensitive directory prefixes against renamed files", () => {
  const paths = validateGithubTriggerProtectedPaths(["CODEOWNERS", "src/secure/"]);
  expect(matchesGithubTriggerProtectedPaths(paths, { filename: "src/secure/access.ts" })).toBe(true);
  expect(matchesGithubTriggerProtectedPaths(paths, { filename: "src/Secure/access.ts" })).toBe(false);
  expect(matchesGithubTriggerProtectedPaths(paths, { filename: "src/public/access.ts", previousFilename: "src/secure/access.ts" })).toBe(true);
  expect(matchesGithubTriggerProtectedPaths(paths, { filename: "CODEOWNERS" })).toBe(true);
  expect(matchesGithubTriggerProtectedPaths(paths, { filename: "CODEOWNERS.bak" })).toBe(false);
});

test.each(["", "/etc/passwd", "C:/Windows", "C:\\Windows", "src\\secure", "src/../secure", "src/./secure", "src//secure", "*.env", "src/[private]/", "src/\u0000secret", "src/\u001fsecret"]) ("unsafe protected path %j is rejected", path => {
  expect(() => validateGithubTriggerProtectedPaths([path])).toThrow(GithubTriggerPathError);
});

test("repository filenames accept literals but malformed names throw", () => {
  expect(validateGithubTriggerRepositoryFilename("src/[literal]!name.ts")).toBe("src/[literal]!name.ts");
  expect(matchesGithubTriggerProtectedPaths([], { filename: "src/[literal]!name.ts" })).toBe(false);
  expect(() => matchesGithubTriggerProtectedPaths([], { filename: "src/../secret" })).toThrow(GithubTriggerPathError);
  expect(() => matchesGithubTriggerProtectedPaths([], { filename: "src/\u0000secret" })).toThrow(GithubTriggerPathError);
});
