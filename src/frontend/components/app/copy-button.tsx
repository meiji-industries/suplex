import { Check, Copy } from "lucide-react";
import { useState, type ReactElement } from "react";
import { Button } from "../ui/button.js";

export function CopyButton({ value, label = "Copy branch comparison" }: { value: string; label?: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      const fallbackCopy = (): void => {
        const input = document.createElement("textarea");
        input.value = value;
        input.setAttribute("readonly", "true");
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.select();
        const copiedByFallback = document.execCommand("copy");
        input.remove();
        if (!copiedByFallback) throw new Error("Clipboard write failed");
      };
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          fallbackCopy();
        }
      } else {
        fallbackCopy();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      setCopied(false);
    }
  };
  return <span className="shrink-0"><Button variant="ghost" size="icon-xs" aria-label={label} title="Copy to clipboard" onClick={() => void copy()}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</Button>{copied ? <span className="pointer-events-none fixed bottom-4 right-4 z-50 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-[11px] text-popover-foreground" role="status" aria-live="polite">Copied to Clipboard</span> : null}</span>;
}
