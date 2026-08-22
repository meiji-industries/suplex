import { globSync, readFileSync } from "node:fs";

import { expect, test } from "vitest";

type Finding = { file: string; line: number; text: string };

// These legacy screens and activity summaries need product-copy review; keep them visible here
// instead of silently weakening the scanner while that broader work is scheduled.
const VOCABULARY_ALLOWLIST: Record<string, string> = {
  "src/frontend/components/app/plan-subject-summary.tsx": "legacy delivery metadata label",
  "src/frontend/views/projects.tsx": "legacy provider-check copy",
  "src/frontend/views/task-details.tsx": "legacy diagnostics copy",
  "src/frontend/views/timeline.tsx": "legacy timeline copy",
  "src/temporal/activities/context.ts": "legacy provider failure summaries",
  "src/temporal/workflow/register-ci.ts": "legacy CI retry labels",
  "src/temporal/workflow/register-planning.ts": "legacy cancellation summary",
  "src/temporal/workflow/runtime.ts": "legacy capacity summary",
};

const lines = (pattern: string): Finding[] => globSync(pattern).flatMap((file) => readFileSync(file, "utf8").split("\n").map((text, index) => ({ file, line: index + 1, text })));
const describe = (findings: Finding[]) => findings.map(({ file, line, text }) => `${file}:${line}: ${text.trim()}`).join("\n");
const source = (pattern: string) => globSync(pattern).map((file) => ({ file, text: readFileSync(file, "utf8") }));

test("response and projection schemas strip unknown keys instead of rejecting them", () => {
  const findings = [
    ...lines("src/http/contracts/**/*.{ts,tsx}"),
    ...lines("src/temporal/contracts/state/**/*.{ts,tsx}"),
  ].filter(({ text }) => /\.strict\(\)/.test(text));

  expect(findings, `Remove .strict() from response/projection schemas:\n${describe(findings)}`).toEqual([]);
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
  for (const { file, text } of source("{src/temporal/workflow,src/temporal/activities,src/frontend}/**/*.{ts,tsx}")) {
    for (const [index, raw] of text.split("\n").entries()) {
      const line = raw.replace(/\/\/.*$/, "");
      const values = [...line.matchAll(/(?:\b(?:pendingAction|summary|blocker|label|title|description|placeholder)\s*[:=]\s*)(["'](?:\\.|[^"'\\])*["']|`(?:\\.|[^`\\])*`)|>([^<{]+)</g)].map((match) => match[1] ?? match[2] ?? "");
      if (!VOCABULARY_ALLOWLIST[file] && values.some((value) => banned.test(value))) findings.push({ file, line: index + 1, text: line });
    }
  }

  expect(findings, `Rewrite user-facing string text without banned proof-language:\n${describe(findings)}`).toEqual([]);
});

const PATCH_IDS = [
  "forge-adopt-observed-head-v1", "forge-auto-chain-halt-v1", "forge-auto-chain-lead-phases-v1", "forge-auto-retry-blockers-v1",
  "forge-auto-start-development-v1", "forge-auto-start-routine-v1", "forge-capacity-ownership-clear-v1", "forge-ci-rerun-v1",
  "forge-ci-update-from-base-v1", "forge-content-hash-contracts-v1", "forge-developer-auto-retry-v1", "forge-failed-retry-v1",
  "forge-kodiak-merge-v1", "forge-merge-conflict-auto-retry-v1", "forge-no-ownership-v2", "forge-plan-review-v1",
  "forge-simple-capacity-v1", "forge-unique-developer-execution-id-v1",
].sort();

test("workflow patch markers remain append-only", () => {
  const present = new Set(lines("src/temporal/**/*.{ts,tsx}").flatMap(({ text }) => [...text.matchAll(/(?:ctx\.)?patched\(["']([^"']+)["']\)/g)].map((match) => match[1])));
  const missing = PATCH_IDS.filter((id) => !present.has(id));
  expect(missing, `Never delete a Temporal patch marker; restore:\n${missing.join("\n")}`).toEqual([]);
});

test("human-owned workflow states always offer an exit and a forward action", () => {
  const terminal = new Set(["cancelled", "done", "merged", "failed-terminal"]);
  const forward = /^(?:retry_development|retry_.+|start_.+|record_.+|approve_.+|respond_.+|continue_work|final_review|request_delivery_changes|resolve_merge_conflict|publish_draft|reconcile_merge|reconcile_ci|revise_plan|resolve_decision_blocker)$/;
  const findings: Finding[] = [];
  for (const { file, text } of source("src/temporal/workflow/**/*.{ts,tsx}")) {
    for (const match of text.matchAll(/(?:\w+\.)?IssueWorkflowStateSchema\.parse\(\{([\s\S]*?)\}\)/g)) {
      const literal = match[1];
      if (!literal) continue;
      const owner = /owner\s*:\s*["']human["']/.test(literal);
      const phase = literal.match(/phase\s*:\s*["']([^"']+)["']/)?.[1];
      const commandLiteral = literal.match(/allowedCommands\s*:\s*\[([^\]]*)\]/)?.[1];
      const commands = commandLiteral?.match(/["']([^"']+)["']/g)?.map((value) => value.slice(1, -1)) ?? [];
      if (owner && phase && commandLiteral && !terminal.has(phase) && (!commands.includes("cancel_issue") || !commands.some((command) => forward.test(command)))) {
        findings.push({ file, line: text.slice(0, match.index).split("\n").length, text: match[0].slice(0, 180) });
      }
    }
  }

  expect(findings, `Human-owned non-terminal state needs cancel_issue plus a forward command:\n${describe(findings)}`).toEqual([]);
});
