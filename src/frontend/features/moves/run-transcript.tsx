import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";

import { EmptyState } from "../../components/app/empty-state.js";
import { terminalTheme } from "../tasks/task-chat/live-pane-terminal.js";
import { getMoveRunTranscript } from "./lib/move-api.js";
import { useIsMobile } from "../../lib/hooks/use-mobile.js";

/** The run's terminal as it was when its process ended, read only. A phone shows no terminal. */
export function RunTranscript(props: { runId: string; label: string }): ReactElement | null {
  return useIsMobile() ? null : <RunTranscriptView {...props} />;
}

function RunTranscriptView({ runId, label }: { runId: string; label: string }): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let terminal: Terminal | undefined;
    let retry = 0;
    let attempts = 0;
    // The host saves the transcript after the process ends, a moment after Stop.
    const read = (): void => {
      getMoveRunTranscript(runId).then(transcript => {
        terminal = new Terminal({ cols: transcript.cols, rows: transcript.rows, disableStdin: true, cursorInactiveStyle: "none", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12, lineHeight: 1.2, scrollback: 10_000, theme: terminalTheme(host) });
        terminal.open(host);
        terminal.write(transcript.output);
      }, () => {
        attempts += 1;
        if (attempts < 3) retry = window.setTimeout(read, 1000);
        else setMissing(true);
      });
    };
    read();
    return () => { attempts = Infinity; window.clearTimeout(retry); terminal?.dispose(); };
  }, [runId]);
  return <div className="min-h-0 flex-1 overflow-auto p-2">
    <div aria-label={label} hidden={missing} ref={hostRef} />
    {missing ? <EmptyState icon={SquareTerminal} title="The terminal ended" /> : null}
  </div>;
}
