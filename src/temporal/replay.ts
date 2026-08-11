import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Worker } from "@temporalio/worker";

import { assertHistoryEventCountWithinLimit } from "./policy.js";

const forbiddenFixtureTerms = /password|secret|credential|authorization|prompt|source|log|description|image/i;

export interface ReplayHistory {
  events: unknown[];
}

export async function readReplayHistory(filename: string): Promise<ReplayHistory> {
  const history = JSON.parse(await readFile(filename, "utf8")) as ReplayHistory;
  if (!history || !Array.isArray(history.events)) throw new Error("Replay fixture must contain an events array");
  assertHistoryEventCountWithinLimit(history.events.length);
  const serialized = JSON.stringify(history);
  if (forbiddenFixtureTerms.test(serialized)) throw new Error("Replay fixture contains forbidden substantive content");
  return history;
}

export async function replayIssueHistory(history: ReplayHistory, workflowId = "workflow-replay-issue-history"): Promise<void> {
  assertHistoryEventCountWithinLimit(history.events.length);
  await Worker.runReplayHistory(
    { workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)) },
    history,
    workflowId,
  );
}

export async function replayIssueHistoryFile(filename: string, workflowId?: string): Promise<void> {
  await replayIssueHistory(await readReplayHistory(filename), workflowId);
}
