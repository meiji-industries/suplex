import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { WorktreeControls } from "../src/frontend/views/task-details.js";

const render = (task: Record<string, unknown>): string => renderToStaticMarkup(createElement(WorktreeControls, { task: { allowedCommands: [], ...task } as never, busy: false, onAction: async () => undefined }));

test("worktree properties always show the current state", () => {
  expect(render({ worktreePath: null, worktreeState: null })).toContain("Worktree</dt><dd");
  expect(render({ worktreePath: null, worktreeState: null })).toContain("None");

  const path = "/Users/x/forge/worktrees/acme/forge/task_11faa20d50cfa686e5bb197e";
  const html = render({ worktreePath: path, worktreeState: "present" });
  expect(html).toContain('class="min-w-0 flex-1 truncate font-mono"');
  expect(html).toContain("task_11faa20d50cfa686e5bb197e");
  expect(html).toContain(`title="${path}"`);
  expect(html).not.toContain('class="flex min-w-0 flex-wrap items-center gap-1"');

  expect(render({ worktreePath: null, worktreeState: "cleaned" })).toContain("Worktree removed");
});
