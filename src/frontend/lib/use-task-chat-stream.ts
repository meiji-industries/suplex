import { useEffect, useRef, useState } from "react";

import type { AgentTimelineEvent } from "../../http/contracts/agent-events.js";
import { chatEventFromTimelineEvent, type ChatEvent } from "./task-chat.js";
import type { ApiTask } from "./view-shared.js";

type AgentEventHistory = { events: AgentTimelineEvent[]; status: { phase: string; terminal: boolean } };

export function useTaskChatStream(taskId: string, _task: ApiTask, onRefresh: () => Promise<void>) {
  const [liveEventsByExecution, setLiveEventsByExecution] = useState<Map<string, ChatEvent[]>>(new Map());
  const cursor = useRef(0);
  const status = useRef("");
  const failures = useRef(0);
  const [streamFailed, setStreamFailed] = useState(false);
  useEffect(() => { setLiveEventsByExecution(new Map()); cursor.current = 0; status.current = ""; failures.current = 0; setStreamFailed(false); }, [taskId]);
  useEffect(() => {
    let active = true;
    const append = (event: AgentTimelineEvent): void => {
      if (!event.executionId) return;
      const mapped = chatEventFromTimelineEvent(event);
      if (!mapped) return;
      cursor.current = Math.max(cursor.current, event.streamId);
      setLiveEventsByExecution((current) => {
        const next = new Map(current);
        const events = next.get(event.executionId!) ?? [];
        next.set(event.executionId!, [...events.filter((candidate) => candidate.id !== mapped.id), mapped]);
        return next;
      });
    };
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/agent-events?after=${cursor.current}`);
        if (!response.ok || !active) return;
        const history = await response.json() as AgentEventHistory;
        history.events.forEach(append);
        status.current = JSON.stringify(history.status);
      } catch { /* The stream reconnect remains the source of live recovery. */ }
    };
    void load();
    const stream = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/agent-events`);
    stream.onopen = () => { failures.current = 0; };
    stream.addEventListener("activity", (message) => {
        try {
          append(JSON.parse((message as MessageEvent<string>).data) as AgentTimelineEvent);
        } catch { /* Ignore malformed activity rows. */ }
    });
    stream.addEventListener("status", (message) => {
        try {
          const next = JSON.stringify(JSON.parse((message as MessageEvent<string>).data) as AgentEventHistory["status"]);
          if (next !== status.current) void onRefresh();
          status.current = next;
        } catch { /* Keep the stream alive. */ }
    });
    stream.onerror = () => {
      failures.current += 1;
      if (failures.current >= 3) {
        stream.close();
        if (active) setStreamFailed(true);
      }
    };
    return () => { active = false; stream.close(); };
  }, [onRefresh, taskId]);
  return { liveEventsByExecution, streamFailed, loadEvents: async (_invocation: ApiTask["agentInvocations"][number]): Promise<void> => undefined };
}
