import { expect, test } from "vitest";
import { queueOrder } from "../features/tasks/lib/task-list.js";

const task = (id: string, createdAt: number, dependsOn: string[] = [], queuePriority = 0) => ({ id, statusChangedAt: new Date(Date.UTC(2026, 0, 1, 0, createdAt)).toISOString(), queuePriority, dependsOn });
const ids = (tasks: ReturnType<typeof task>[]) => queueOrder(tasks).map(value => value.id);

test("queue order puts a chain after its root when the server lists it in reverse", () => {
  expect(ids([task("c", 3, ["b"]), task("a", 1), task("b", 2, ["a"])])).toEqual(["a", "b", "c"]);
});

test("queue order groups each chain after its root with roots in created order", () => {
  expect(ids([task("y2", 5, ["y1"]), task("x2", 4, ["x1"]), task("y1", 1), task("x1", 2), task("x3", 3, ["x2"])])).toEqual(["y1", "y2", "x1", "x2", "x3"]);
});

test("queue order places a task after all of its queued blockers", () => {
  expect(ids([task("c", 1, ["a", "b"]), task("b", 3), task("a", 2), task("d", 4, ["a"])])).toEqual(["a", "d", "b", "c"]);
});

test("queue order treats a task blocked only outside the column as a root", () => {
  expect(ids([task("b", 2, ["a"]), task("a", 3, ["active-task"]), task("c", 1)])).toEqual(["c", "a", "b"]);
});

test("queue order keeps every task exactly once in a cycle", () => {
  expect(ids([task("b", 2, ["a"]), task("a", 1, ["b"]), task("d", 4, ["c"]), task("c", 3, ["c"]), task("e", 0)])).toEqual(["e", "a", "b", "c", "d"]);
});

test("promoted tasks precede FIFO tasks while prerequisites stay first", () => {
  expect(ids([task("first", 1), task("promoted", 3, [], 1), task("blocked", 4, ["first"], 2)])).toEqual(["promoted", "first", "blocked"]);
});
