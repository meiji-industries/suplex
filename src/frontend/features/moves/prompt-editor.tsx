import type { ReactElement, ReactNode } from "react";

import { cn } from "../../lib/utils.js";
import { moveInputs } from "./lib/move-inputs.js";

const command = /(`[^`\n]*`)/g;
const inputToken = /(\{\{[^{}]*\}\})/g;

function inputs(text: string): ReactNode[] {
  return text.split(inputToken).map((part, index) => part.startsWith("{{") && moveInputs(part).length ? <span key={index} className="rounded-sm bg-primary/15 text-primary">{part}</span> : part);
}

/** Inputs and inline commands in the prompt, colored without changing glyph widths so the caret stays aligned. */
function highlighted(prompt: string): ReactNode[] {
  return prompt.split(command).map((part, index) => part.startsWith("`") && part.length > 1 ? <span key={index} className="rounded-sm bg-muted text-foreground">{inputs(part)}</span> : <span key={index}>{inputs(part)}</span>);
}

/** A shell script field, styled as a terminal: a highlighted copy sits under a transparent textarea of the same text. */
export function ScriptEditor({ value, onChange, placeholder, disabled, label }: { value: string; onChange: (value: string) => void; placeholder: string; disabled: boolean; label: string }): ReactElement {
  const shared = "whitespace-pre-wrap break-words py-2.5 pr-3 pl-8 font-mono text-[13px] leading-6";
  return <div className="dark relative grid min-h-32 rounded-md border border-zinc-800 bg-zinc-950 text-zinc-100">
    <span aria-hidden="true" className="pointer-events-none absolute top-2.5 left-3 font-mono text-[13px] leading-6 text-emerald-400 select-none">$</span>
    <pre aria-hidden="true" className={cn(shared, "col-start-1 row-start-1 m-0 text-zinc-100")}>{highlighted(value)}{"\n"}</pre>
    <textarea
      aria-label={label}
      spellCheck={false}
      disabled={disabled}
      placeholder={placeholder}
      value={value}
      onChange={event => onChange(event.target.value)}
      className={cn(shared, "absolute inset-0 size-full resize-none overflow-hidden bg-transparent text-transparent caret-emerald-400 outline-none placeholder:text-zinc-500 selection:bg-emerald-400/25 selection:text-transparent")}
    />
  </div>;
}
