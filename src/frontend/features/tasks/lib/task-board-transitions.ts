import type { TaskControlStatus } from "../../../contracts/task-control.js";
import type { TaskAction } from "./task-api.js";

export type BoardMove = { from: TaskControlStatus; to: TaskControlStatus; action: TaskAction; label: string };

/** The board moves. Each one runs a task action, and a card moves one column at a time. The server decides the resulting status. */
export const boardMoves: readonly BoardMove[] = [
  { from: "backlog", to: "queued", action: "start", label: "Start the task" },
  { from: "queued", to: "backlog", action: "disarm", label: "Move the task to Backlog" },
  { from: "queued", to: "active", action: "force-start", label: "Start the task now" },
  { from: "active", to: "cancelled", action: "cancel", label: "Cancel the task" },
];

export function boardMove(from: TaskControlStatus, to: TaskControlStatus): BoardMove | undefined {
  return boardMoves.find(move => move.from === from && move.to === to);
}

export function boardMovesFrom(from: TaskControlStatus): BoardMove[] {
  return boardMoves.filter(move => move.from === from);
}
