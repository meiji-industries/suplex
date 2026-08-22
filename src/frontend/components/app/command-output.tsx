import { Check, Copy } from "lucide-react";
import { useState, type ReactElement } from "react";

import { relativeTime } from "../../lib/view-shared.js";
import { Button } from "../ui/button.js";

export type CommandOutput = {
  command: string;
  cwd?: string | undefined;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  at: string;
  /** Preserved stream ordering, when a provider captures it. */
  entries?: Array<{ stream: "stdout" | "stderr"; text: string }> | undefined;
};

const ansiEscape = /\u001B(?:[@-_][0-?]*[ -/]*[@-~]|\[[0-?]*[ -/]*[@-~])/g;

export function stripAnsi(value: string): string {
  return value.replace(ansiEscape, "");
}

function lastLine(value: string): string {
  return stripAnsi(value).trimEnd().split(/\r?\n/).at(-1) ?? "";
}

function duration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

function CopyOutputButton({ value }: { value: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  return <Button variant="ghost" size="xs" aria-label="Copy command output" onClick={(event) => { event.stopPropagation(); void copy(); }}>
    {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />} Copy
  </Button>;
}

export function CommandOutputBlock({ output, defaultExpanded = false }: { output: CommandOutput; defaultExpanded?: boolean }): ReactElement {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const failed = output.exitCode !== 0 && output.exitCode !== null;
  const collapsedLine = failed ? lastLine(output.stderr) : lastLine(output.stdout);
  const entries = output.entries?.length ? output.entries : [
    ...(output.stdout ? [{ stream: "stdout" as const, text: output.stdout }] : []),
    ...(output.stderr ? [{ stream: "stderr" as const, text: output.stderr }] : []),
  ];
  const fullOutput = entries.map((entry) => stripAnsi(entry.text)).join("\n");
  const hasOutput = entries.length > 0;

  return <section data-command-output className="min-w-0 overflow-hidden rounded-md border border-border bg-muted/30 font-mono text-[11px] leading-5">
    <button type="button" className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-1.5 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
      <span className="min-w-0 break-all text-foreground">$ {stripAnsi(output.command)}</span>
      <span className={failed ? "rounded bg-red-500/15 px-1 text-red-600 dark:text-red-400" : "rounded bg-green-500/15 px-1 text-green-700 dark:text-green-400"}>exit {output.exitCode ?? "—"}</span>
      <span className="text-muted-foreground">{duration(output.durationMs)}</span>
      <time className="text-muted-foreground" dateTime={output.at} title={new Date(output.at).toLocaleString()}>{relativeTime(output.at)}</time>
      {!expanded && collapsedLine ? <span data-command-output-tail className={failed ? "w-full truncate text-red-600 dark:text-red-400" : "w-full truncate text-muted-foreground"}>{collapsedLine}</span> : null}
    </button>
    {expanded && hasOutput ? <div className="border-t border-border">
      <div className="max-h-56 overflow-auto px-2 py-1.5" data-command-output-body>
        {entries.map((entry, index) => <pre className={entry.stream === "stderr" ? "whitespace-pre text-red-600 dark:text-red-400" : "whitespace-pre text-foreground"} key={`${entry.stream}-${index}`}>{stripAnsi(entry.text)}</pre>)}
      </div>
      <div className="flex justify-end border-t border-border px-1 py-1"><CopyOutputButton value={fullOutput} /></div>
    </div> : null}
  </section>;
}
