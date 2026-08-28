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
  "forge-adopt-observed-head-v1", "forge-adopt-source-pull-request-v1", "forge-adopt-source-pull-request-v2", "forge-auto-chain-halt-v1", "forge-auto-chain-lead-phases-v1", "forge-auto-retry-blockers-v1",
  "forge-auto-start-development-v1", "forge-auto-start-routine-v1", "forge-capacity-ownership-clear-v1", "forge-ci-rerun-v1",
  "forge-ci-update-from-base-v1", "forge-content-hash-contracts-v1", "forge-developer-auto-retry-v1",
  "forge-developer-continuation-v1",
  "forge-developer-start-failure-auto-retry-v1", "forge-developer-start-failure-blocked-v1", "forge-failed-retry-v1",
  "forge-simple-capacity-v1", "forge-unique-developer-execution-id-v1",
].sort();

test("workflow patch markers remain append-only", () => {
  const present = new Set(lines("src/temporal/**/*.{ts,tsx}").flatMap(({ text }) => [...text.matchAll(/(?:ctx\.)?patched\(["']([^"']+)["']\)/g)].map((match) => match[1])));
  const missing = PATCH_IDS.filter((id) => !present.has(id));
  expect(missing, `Never delete a Temporal patch marker; restore:\n${missing.join("\n")}`).toEqual([]);
});

test("human-owned workflow states always offer an exit and a forward action", () => {
  const terminal = new Set(["cancelled", "done", "merged", "failed-terminal"]);
  const forward = /^(?:repair_ci|repair_delivery|review_delivery|retry_development|retry_.+|start_.+|record_.+|approve_.+|respond_.+|continue_work|final_review|request_delivery_changes|resolve_merge_conflict|publish_draft|reconcile_acceptance|reconcile_merge|reconcile_ci|revise_plan|resolve_decision_blocker)$/;
  const commandArrays = (text: string, literal: string): string[][] => {
    const commandStart = literal.search(/allowedCommands\s*:/);
    if (commandStart < 0) return [];
    const commandEnd = literal.slice(commandStart).search(/,\s*pendingAction\s*:/);
    const expression = literal.slice(commandStart, commandEnd < 0 ? undefined : commandStart + commandEnd);
    const variable = expression.match(/allowedCommands\s*:\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/)?.[1];
    const helper = expression.match(/allowedCommands\s*:\s*([A-Za-z_$][\w$]*)\s*\(/)?.[1];
    const assignment = variable ? text.match(new RegExp(`(?:const|let)\\s+${variable}[^=]*=\\s*([\\s\\S]*?);`))?.[1] ?? "" : "";
    const returned = helper ? text.match(new RegExp(`(?:function\\s+${helper}[^{]*\\{|(?:const|let)\\s+${helper}\\s*=\\s*[^=]*=>\\s*\\{)([\\s\\S]*?)(?:\\n\\}|\\n\\};)`))?.[1] ?? "" : "";
    return [expression, assignment, returned].filter(Boolean).flatMap((value) => {
      const arrays: string[][] = [];
      for (let start = 0; start < value.length; start += 1) {
        if (value[start] !== "[") continue;
        let depth = 1;
        let end = start + 1;
        for (; end < value.length && depth; end += 1) {
          if (value[end] === "[") depth += 1;
          if (value[end] === "]") depth -= 1;
        }
        if (!depth) arrays.push(value.slice(start, end).match(/["']([^"']+)["']/g)?.map((command) => command.slice(1, -1)) ?? []);
        start = end - 1;
      }
      return arrays.length ? arrays : [value.match(/["']([^"']+)["']/g)?.map((command) => command.slice(1, -1)) ?? []];
    });
  };
  const stateLiterals = (text: string): Array<{ index: number; literal: string }> => {
    const states: Array<{ index: number; literal: string }> = [];
    for (const match of text.matchAll(/(?:\w+\.)?IssueWorkflowStateSchema\.parse\(\{/g)) {
      let depth = 1;
      let quote: string | null = null;
      let end = match.index! + match[0].length;
      for (; end < text.length && depth; end += 1) {
        const character = text[end];
        if (quote) {
          if (character === "\\") end += 1;
          else if (character === quote) quote = null;
          continue;
        }
        if (character === "'" || character === '"' || character === "`") { quote = character; continue; }
        if (character === "{") depth += 1;
        if (character === "}") depth -= 1;
      }
      if (!depth) states.push({ index: match.index!, literal: text.slice(match.index! + match[0].length, end - 1) });
    }
    return states;
  };
  const findings: Finding[] = [];
  for (const { file, text } of source("src/temporal/workflow/**/*.{ts,tsx}")) {
    for (const match of stateLiterals(text)) {
      const { literal } = match;
      const owner = /owner\s*:\s*[^,]*["']human["']/.test(literal);
      const phaseStart = literal.search(/phase\s*:/);
      const phaseEnd = literal.search(/owner\s*:/);
      const phases = phaseStart < 0 ? [] : [...literal.slice(phaseStart, phaseEnd < 0 ? undefined : phaseEnd).matchAll(/["']([^"']+)["']/g)].flatMap((value) => value[1] ? [value[1]] : []);
      const commandSets = commandArrays(text, literal);
      const humanCommands = /owner\s*:\s*[^?]+\?\s*["'](?:lead|system)["']\s*:\s*["']human["']/.test(literal) && commandSets.length > 1 ? commandSets.slice(1) : commandSets;
      if (owner && phases.some((phase) => !terminal.has(phase)) && humanCommands.some((commands) => !commands.includes("cancel_issue") || !commands.some((command) => forward.test(command)))) {
        findings.push({ file, line: text.slice(0, match.index).split("\n").length, text: literal.slice(0, 180) });
      }
    }
  }

  expect(findings, `Human-owned non-terminal state needs cancel_issue plus a forward command:\n${describe(findings)}`).toEqual([]);
});
