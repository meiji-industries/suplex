import { useEffect, useRef, useState } from "react";

import type { AgentTimelineEvent } from "../../http/contracts/agent-events.js";
import { taskDetailNeedsRefresh, type TaskDetailStatus } from "./task-detail-status.js";
import { chatEventFromTimelineEvent, mergeChatEvent, type ChatEvent } from "./task-chat.js";
import type { ApiTask } from "./view-shared.js";

type AgentEventHistory = { events: AgentTimelineEvent[]; status: TaskDetailStatus };
export type LivePaneState = { role: string; paneId: string | null; status: string | null };

export function useTaskChatStream(taskId: string, _task: ApiTask, onRefresh: () => Promise<void>) {
  const [liveEventsByExecution, setLiveEventsByExecution] = useState<Map<string, ChatEvent[]>>(new Map());
  const cursor = useRef(0);
  const status = useRef<TaskDetailStatus | undefined>(undefined);
  const failures = useRef(0);
  const onRefreshRef = useRef(onRefresh);
  const [streamFailed, setStreamFailed] = useState(false);
  const [panes, setPanes] = useState<LivePaneState[]>([]);
  onRefreshRef.current = onRefresh;
  useEffect(() => { setLiveEventsByExecution(new Map()); cursor.current = 0; status.current = undefined; failures.current = 0; setStreamFailed(false); }, [taskId]);
  useEffect(() => {
    let active = true;
    const append = (event: AgentTimelineEvent): void => {
      if (!event.executionId) return;
      const mapped = chatEventFromTimelineEvent(event);
      if (!mapped) return;
      cursor.current = Math.max(cursor.current, event.streamId);
      setLiveEventsByExecution((current) => {
        const events = current.get(event.executionId!) ?? [];
        const merged = mergeChatEvent(events, mapped);
        if (merged.length === events.length && merged.every((candidate, index) => candidate === events[index])) return current;
        const next = new Map(current);
        next.set(event.executionId!, merged);
        return next;
      });
    };
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/agent-events?after=${cursor.current}`);
        if (!response.ok || !active) return;
        const history = await response.json() as AgentEventHistory;
        history.events.forEach(append);
        if (!status.current) status.current = history.status;
      } catch { /* The stream reconnect remains the source of live recovery. */ }
    };
    void load();
    const stream = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/agent-events?after=${cursor.current}`);
    stream.onopen = () => { failures.current = 0; };
    stream.addEventListener("activity", (message) => {
        try {
          append(JSON.parse((message as MessageEvent<string>).data) as AgentTimelineEvent);
        } catch { /* Ignore malformed activity rows. */ }
    });
    stream.addEventListener("status", (message) => {
        try {
          const next = JSON.parse((message as MessageEvent<string>).data) as TaskDetailStatus;
          if (taskDetailNeedsRefresh(status.current, next)) void onRefreshRef.current();
          status.current = next;
        } catch { /* Keep the stream alive. */ }
    });
    stream.addEventListener("panes", (message) => { try { setPanes(JSON.parse((message as MessageEvent<string>).data) as LivePaneState[]); } catch { /* Ignore malformed pane state. */ } });
    stream.onerror = () => {
      failures.current += 1;
      if (failures.current >= 3) {
        stream.close();
        if (active) setStreamFailed(true);
      }
    };
    return () => { active = false; stream.close(); };
  }, [taskId]);
  return { liveEventsByExecution, streamFailed, panes, loadEvents: async (_invocation: ApiTask["agentInvocations"][number]): Promise<void> => undefined };
}
