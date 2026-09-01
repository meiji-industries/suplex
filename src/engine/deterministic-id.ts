import { createHash } from "node:crypto";

import { runExecution } from "./registry.js";

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

export function developerExecutionId(workflowId: string, planRevision: number, attempt: number, turnKind: "implementation" | "repair" | "merge_conflict_resolution", commandId?: string): string {
  return `developer_${sha256Hex(`${workflowId}\0${planRevision}\0${attempt}\0${turnKind}${commandId === undefined ? "" : `\0${commandId}`}`).slice(0, 24)}`;
}

export function workflowTimestamp(): string {
  const clock = globalThis.Date;
  return new clock(runExecution.current().now()).toISOString();
}
