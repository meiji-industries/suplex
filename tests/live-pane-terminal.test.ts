import { expect, test } from "vitest";

import { preservedViewportLine } from "../src/frontend/components/app/task-chat/live-pane-terminal.js";

test("live panes follow new output only while already at the bottom", () => {
  expect(preservedViewportLine(true, 0, 120)).toBe(120);
  expect(preservedViewportLine(false, 18, 125)).toBe(107);
  expect(preservedViewportLine(false, 200, 125)).toBe(0);
});
