import { globSync, readFileSync } from "node:fs";

import { expect, test } from "vitest";
import { TaskResponseSchema } from "../src/frontend/contracts/task-responses.js";
import { TaskInputSchema } from "../src/frontend/contracts/tasks.js";
import { ProjectResponseSchema, ProfileResponseSchema } from "../src/frontend/contracts/projects.js";

type Finding = { file: string; line: number; text: string };

// These legacy screens and activity summaries need product-copy review; keep them visible here
// instead of silently weakening the scanner while that broader work is scheduled.
const VOCABULARY_ALLOWLIST: Record<string, string> = {
  "src/frontend/components/app/plan-subject-summary.tsx": "legacy delivery metadata label",
  "src/frontend/features/projects/projects.tsx": "legacy provider-check copy",
  "src/frontend/features/tasks/task-details.tsx": "legacy diagnostics copy",
  "src/frontend/features/timeline/timeline.tsx": "legacy timeline copy",
};

const lines = (pattern: string): Finding[] => globSync(pattern).flatMap((file) => readFileSync(file, "utf8").split("\n").map((text, index) => ({ file, line: index + 1, text })));
const describe = (findings: Finding[]) => findings.map(({ file, line, text }) => `${file}:${line}: ${text.trim()}`).join("\n");
const source = (pattern: string) => globSync(pattern).map((file) => ({ file, text: readFileSync(file, "utf8") }));

test("public responses strip extra keys while mutation requests reject them", () => {
  const frozen = JSON.parse(readFileSync("tests/parity/task-response-native/expected.json", "utf8")) as { body: string };
  const task: unknown = JSON.parse(frozen.body);
  const parsed = TaskResponseSchema.parse(task);
  expect(TaskResponseSchema.parse({ ...parsed, extra: "future" })).toEqual(parsed);
  const project = ProjectResponseSchema.parse({ id: "p", companyId: "c", name: "Project", repositoryPath: "/repo", worktreeRoot: "/worktrees", repository: "owner/repo", baseBranch: "main", setupCommand: "", verificationCommand: "", rootProfileId: "root", workerProfileId: "worker", createdAt: "now", updatedAt: "now" });
  expect(ProjectResponseSchema.parse({ ...project, extra: "future" })).toEqual(project);
  const profile = ProfileResponseSchema.parse({ id: "root", name: "Root", role: "root", avatarSeed: "a".repeat(32), provider: "codex", model: "gpt-6-sol", reasoningLevel: "medium", serviceTier: "priority", providerInstanceId: null, archivedAt: null, createdAt: "now", updatedAt: "now" });
  expect(ProfileResponseSchema.parse({ ...profile, extra: "future" })).toEqual(profile);
  expect(TaskInputSchema.safeParse({ projectId: "p", title: "Useful task", idempotencyKey: "contract-test", extra: "not allowed" }).success).toBe(false);
});

test("free-text schemas do not cap an agent or operator's message", () => {
  const freeTextField = /\b(?:summary|reason|message|description|title|name|command|args|note|answer|evidence|question|instruction|verification|rationale|diagnosis|rootCause|repairPlan|blocker|nextAction|concerns|changes|files|checks|results|issues|questions)\w*\s*:/i;
  const findings = lines("src/**/*.{ts,tsx}").filter(({ text }) => (
    /z\.string\([^)]*\)(?:\.\w+\([^)]*\))*\.max\(|z\.array\(\s*z\.string\([^)]*\)(?:\.\w+\([^)]*\))*\.max\(/.test(text)
    && freeTextField.test(text)
    && !/\/\/ bound: .+/.test(text)
  ));

  expect(findings, `Remove a free-text .max(), or document a non-text bound on the same line:\n${describe(findings)}`).toEqual([]);
});

test("error wrappers retain the caught failure as diagnostic context", () => {
  const findings: Finding[] = [];
  for (const { file, text } of source("src/**/*.{ts,tsx}")) {
    for (const match of text.matchAll(/catch\s*\(\s*(\w+)\s*\)\s*\{/g)) {
      const error = match[1];
      let depth = 1;
      let end = match.index! + match[0].length;
      for (; end < text.length && depth; end += 1) {
        if (text[end] === "{") depth += 1;
        if (text[end] === "}") depth -= 1;
      }
      const body = text.slice(match.index!, end);
      const wrapsConstant = new RegExp(`catch\\s*\\(\\s*${error}\\s*\\)\\s*\\{\\s*(?:if\\s*\\([^)]*\\)\\s*throw\\s+${error};\\s*)?(?:const\\s+\\w+\\s*=\\s*${error}[^;]*;\\s*)?(?:throw\\s+)?new\\s+(?:Error|AgentFailure|TaskFailure)\\s*\\(\\s*["'\\\`][^"'\\\`$]*["'\\\`]`).test(body);
      const keepsCause = new RegExp(`(?:${error}\\.message|cause\\s*:\\s*${error}|String\\s*\\(\\s*${error}\\s*\\)|(?:log|error|warn)\\s*\\([^)]*${error})`).test(body);
      if (wrapsConstant && !keepsCause) {
        findings.push({ file, line: text.slice(0, match.index).split("\n").length, text: match[0] });
      }
    }
  }

  expect(findings, `Preserve the caught error in the wrapper's message, cause, or log:\n${describe(findings)}`).toEqual([]);
});

test("workflow and UI strings avoid proof-language that users cannot act on", () => {
  const banned = /\b(?:exact|recorded|authoritative|bounded|reconcil\w*|ownership|sha256|integrity|lineage)\b/i;
  const findings: Finding[] = [];
  for (const { file, text } of source("src/frontend/**/*.{ts,tsx}")) {
    for (const [index, raw] of text.split("\n").entries()) {
      const line = raw.replace(/\/\/.*$/, "");
      const values = [...line.matchAll(/(?:\b(?:pendingAction|summary|blocker|label|title|description|placeholder)\s*[:=]\s*)(["'](?:\\.|[^"'\\])*["']|`(?:\\.|[^`\\])*`)|>([^<{]+)</g)].map((match) => match[1] ?? match[2] ?? "");
      if (!VOCABULARY_ALLOWLIST[file] && values.some((value) => banned.test(value))) findings.push({ file, line: index + 1, text: line });
    }
  }

  expect(findings, `Rewrite user-facing string text without banned proof-language:\n${describe(findings)}`).toEqual([]);
});
