import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { expect, test } from "vitest";

import { filterTaskSources, prefillForTaskSource, preserveEditedPrefill, selectorForTaskSource, taskSourceTabs, TaskSourcePicker, type TaskSourceSummary } from "../src/frontend/components/app/task-source-picker.js";

const pull: TaskSourceSummary = { kind: "pull_request", number: 17, title: "Improve picker", body: "PR body", author: "octo", headBranch: "feature/picker", baseBranch: "main", isDraft: false };
const branch: TaskSourceSummary = { kind: "branch", branch: "feature/search", headSha: "a".repeat(40), subject: "Add search", author: "hubot" };

test("the picker renders its compact source trigger", () => {
  const html = renderToStaticMarkup(createElement(TaskSourcePicker, { projectId: "project-1", onSelect: () => {}, onClear: () => {} }));
  expect(html).toContain("Create from…"); expect(html).toContain('aria-label="Create from source"');
});

test("picker search covers PR metadata and branch metadata", () => {
  expect(taskSourceTabs).toEqual([{ value: "pull_request", label: "Pull requests" }, { value: "branch", label: "Branches" }]);
  expect(filterTaskSources([pull, branch], "17")).toEqual([pull]);
  expect(filterTaskSources([pull, branch], "octo")).toEqual([pull]);
  expect(filterTaskSources([pull, branch], "feature/search")).toEqual([branch]);
  expect(filterTaskSources([pull, branch], "Add search")).toEqual([branch]);
});

test("selection produces only the stable selector payload", () => {
  expect(selectorForTaskSource(pull)).toEqual({ kind: "pull_request", number: 17 });
  expect(selectorForTaskSource(branch)).toEqual({ kind: "branch", branch: "feature/search" });
});

test("source prefill remains editable and only generated values are replaced", () => {
  const first = prefillForTaskSource(pull); const next = prefillForTaskSource(branch);
  expect(preserveEditedPrefill(first, first, next)).toEqual(next);
  expect(preserveEditedPrefill({ title: "My title", description: first.description }, first, next)).toEqual({ title: "My title", description: next.description });
  expect(preserveEditedPrefill({ title: first.title, description: "My description" }, first, next)).toEqual({ title: next.title, description: "My description" });
});
