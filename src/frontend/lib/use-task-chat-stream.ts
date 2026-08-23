import { useCallback, useEffect, useRef, useState } from "react";

import type { DeveloperExecutionEventResponse } from "../../http/contracts/tasks.js";
import { extractAgentTranscript } from "../components/app/task-history.js";
import { readJson } from "./api.js";
import { chatEventFromDeveloperEvent, type ChatEvent } from "./task-chat.js";
import type { ApiTask } from "./view-shared.js";
import { TERMINAL_PHASES } from "../../issue-phases.js";

type ExecutionStatus = { status: string; execution: { id: string } | null };
type EventResponse = { events: DeveloperExecutionEventResponse[] };

export function useTaskChatStream(taskId: string, task: ApiTask, onRefresh: () => Promise<void>) {
  const [liveEventsByExecution, setLiveEventsByExecution] = useState<Map<string, ChatEvent[]>>(new Map());
  const refreshed = useRef(new Set<string>());
  useEffect(() => { setLiveEventsByExecution(new Map()); refreshed.current = new Set(); }, [taskId]);
  useEffect(() => {
    if (TERMINAL_PHASES.has(task.phase)) return;
    const streams = ["planning-events", "development-events"].map((path) => {
      const stream = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/${path}`);
      stream.addEventListener("progress", (message) => {
        try {
          const event = chatEventFromDeveloperEvent(JSON.parse((message as MessageEvent<string>).data) as DeveloperExecutionEventResponse);
          const executionId = (message as MessageEvent<string>).lastEventId.split(":")[0];
          if (!executionId) return;
          setLiveEventsByExecution((current) => {
            const next = new Map(current);
            const events = next.get(executionId) ?? [];
            next.set(executionId, [...events.filter((candidate) => candidate.id !== event.id), event]);
            return next;
          });
        } catch { /* Ignore malformed progress. */ }
      });
      stream.addEventListener("status", (message) => {
        try {
          const value = JSON.parse((message as MessageEvent<string>).data) as ExecutionStatus;
          const key = value.execution?.id && ["completed", "failed", "blocked", "result_pending_claim"].includes(value.status) ? `${value.execution.id}:${value.status}` : "";
          if (key && !refreshed.current.has(key)) { refreshed.current.add(key); void onRefresh(); }
        } catch { /* Keep the stream alive. */ }
      });
      return stream;
    });
    return () => streams.forEach((stream) => stream.close());
  }, [onRefresh, task.phase, taskId]);
  const loadEvents = useCallback(async (invocation: ApiTask["agentInvocations"][number]): Promise<void> => {
    if (liveEventsByExecution.has(invocation.id)) return;
    if (invocation.role === "planner" && invocation.evidenceArtifactId) {
      const evidence = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(invocation.evidenceArtifactId)}`).then((response) => response.ok ? response.text() : "");
      const transcript = extractAgentTranscript(evidence);
      if (transcript) setLiveEventsByExecution((current) => new Map(current).set(invocation.id, [{ id: `evidence-${invocation.id}`, at: invocation.finishedAt ?? invocation.startedAt, kind: "agent_update", text: transcript }]));
      return;
    }
    if (invocation.role !== "planner") {
      const response = await readJson<EventResponse>(`/api/tasks/${encodeURIComponent(taskId)}/developer-executions/${encodeURIComponent(invocation.id)}/events`);
      setLiveEventsByExecution((current) => new Map(current).set(invocation.id, response.events.map(chatEventFromDeveloperEvent)));
    }
  }, [liveEventsByExecution, taskId]);
  return { liveEventsByExecution, loadEvents };
}
