import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { expect, test } from "vitest";

import { filterTaskSources, prefillForTaskSource, preserveEditedPrefill, selectorForTaskSource, taskSourceTabs, TaskSourcePicker, type TaskSourceSummary } from "../src/frontend/features/tasks/task-source-picker.js";

const pull: TaskSourceSummary = { kind: "pull_request", number: 17, title: "Improve picker", body: "PR body", author: "octo", headBranch: "feature/picker", baseBranch: "main", isDraft: false };
const branch: TaskSourceSummary = { kind: "branch", branch: "feature/search", headSha: "a".repeat(40), subject: "Add search", author: "hubot" };

test("the picker renders its compact source trigger", () => {
  const html = renderToStaticMarkup(createElement(TaskSourcePicker, { projectId: "project-1", onSelect: () => {}, onClear: () => {} }));
  expect(html).toContain("New from…"); expect(html).toContain('aria-label="New from source"'); expect(html).toContain("lucide-circle-plus");
});

test("picker search covers PR metadata and branch metadata", () => {
  expect(taskSourceTabs).toEqual([{ value: "pull_request", label: "Pull requests" }, { value: "issue", label: "Issues" }, { value: "branch", label: "Branches" }]);
  expect(filterTaskSources([pull, branch], "17")).toEqual([pull]);
  expect(filterTaskSources([pull, branch], "octo")).toEqual([pull]);
  expect(filterTaskSources([pull, branch], "feature/search")).toEqual([branch]);
  expect(filterTaskSources([pull, branch], "Add search")).toEqual([branch]);
});

test("selection produces only the stable selector payload", () => {
  expect(selectorForTaskSource(pull)).toEqual({ kind: "pull_request", number: 17 });
  expect(selectorForTaskSource(branch)).toEqual({ kind: "branch", branch: "feature/search" });
});

test("source menu rows use Base UI's activation event", () => {
  const source = readFileSync(new URL("../src/frontend/features/tasks/task-source-picker.tsx", import.meta.url), "utf8");
  expect(source).toContain("onClick={() => row.kind === \"issue\" ? onSelect(row) : onSelect(row, selectorForTaskSource(row))}");
  expect(source).not.toContain("onSelect={() => row.kind === \"issue\"");
});

test("source prefill remains editable and only generated values are replaced", () => {
  const first = prefillForTaskSource(pull); const next = prefillForTaskSource(branch);
  expect(first).toEqual({ title: "Improve picker", description: "" });
  expect(preserveEditedPrefill(first, first, next)).toEqual(next);
  expect(preserveEditedPrefill({ title: "My title", description: first.description }, first, next)).toEqual({ title: "My title", description: next.description });
  expect(preserveEditedPrefill({ title: first.title, description: "My description" }, first, next)).toEqual({ title: next.title, description: "My description" });
});

test("issues prefill the title and URL with their resolved association", () => {
  const issue: TaskSourceSummary = { kind: "issue", issue: { kind: "github", repository: "acme/forge", number: 42, id: "42", key: "#42", title: "Fix search", url: "https://github.com/acme/forge/issues/42" } };
  expect(prefillForTaskSource(issue)).toEqual({ title: "Fix search", description: "Work on #42: https://github.com/acme/forge/issues/42" });
  expect(filterTaskSources([pull, branch, issue], "42")).toEqual([issue]);
});
