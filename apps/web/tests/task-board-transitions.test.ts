import { expect, test } from "vitest";
import { TaskControlStatusSchema } from "../contracts/task-control.js";
import { boardMove } from "../features/tasks/lib/task-board-transitions.js";

test("the board permits the one-column moves and the moves back to Backlog, and no others", () => {
  const permitted = TaskControlStatusSchema.options.flatMap(from => TaskControlStatusSchema.options.map(to => [from, to, boardMove(from, to)?.action] as const)).filter(([, , action]) => action);
  expect(permitted).toEqual([
    ["backlog", "queued", "start"],
    ["queued", "backlog", "disarm"],
    ["queued", "active", "force-start"],
    ["active", "backlog", "backlog"],
    ["active", "cancelled", "cancel"],
    ["waiting_human", "backlog", "backlog"],
    ["cancelled", "backlog", "backlog"],
  ]);
});
