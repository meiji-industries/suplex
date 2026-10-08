import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TaskSetup } from "../../../contracts/generated/TaskSetup.js";
import { readTaskSetupLog } from "../lib/task-api.js";
import { setupStatus } from "../setup-status.js";
import { historyAtBottom } from "./session-history-state.js";

export function SetupLog({ taskId, setup }: { taskId: string; setup: TaskSetup }) {
  const [log, setLog] = useState({ setup, output: "" });
  const [error, setError] = useState<string>();
  const viewport = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      let retry = true;
      try {
        // Polls the full log. Use byte cursors if setup logs become large.
        const result = await readTaskSetupLog(taskId, abort.signal);
        if (abort.signal.aborted) return;
        setLog(result);
        setError(undefined);
        retry = result.setup.state === "running";
      } catch {
        if (!abort.signal.aborted) setError("Suplex could not read the setup log. Suplex will retry.");
      }
      if (!abort.signal.aborted && retry) timer = setTimeout(() => void read(), 1000);
    };
    void read();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [taskId, setup.state, setup.exitStatus]);
  useLayoutEffect(() => {
    if (viewport.current && following.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [log.output]);
  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
    <p role="status" className="shrink-0 px-3 py-1 text-xs">{setupStatus(log.setup)}</p>
    {error ? <p role="alert" className="px-3 text-xs">{error}</p> : null}
    <pre ref={viewport} aria-label="Setup output" className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs" onScroll={event => { following.current = historyAtBottom(event.currentTarget); }}>{log.output}</pre>
  </div>;
}
