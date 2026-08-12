import { Check, Copy } from "lucide-react";
import { useState, type ReactElement } from "react";

import { Button } from "../ui/button.js";

type Revision = {
  baseSha: string;
  baseShaAbbrev: string;
  subjectCommit: string;
  subjectCommitAbbrev: string;
  subjectTree: string;
  subjectTreeAbbrev: string;
};

function CopyValue({ label, value }: { label: string; value: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_200);
    } catch {
      setCopied(false);
    }
  };
  return <Button variant="ghost" size="icon-xs" aria-label={`Copy full ${label}`} onClick={() => void copy()}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</Button>;
}

export function RevisionIdentity({ revision }: { revision: Revision }): ReactElement {
  const entries = [
    ["base", revision.baseSha, revision.baseShaAbbrev],
    ["head", revision.subjectCommit, revision.subjectCommitAbbrev],
    ["tree", revision.subjectTree, revision.subjectTreeAbbrev],
  ] as const;
  return (
    <div className="min-w-0 space-y-1 text-[11px]">
      {entries.map(([label, full, abbreviated]) => (
        <div className="flex min-w-0 items-center gap-1.5" key={label}>
          <span className="w-8 shrink-0 text-muted-foreground">{label}</span>
          <code className="min-w-0 flex-1 truncate" title={full}>{abbreviated}</code>
          <CopyValue label={label} value={full} />
        </div>
      ))}
      <details className="min-w-0">
        <summary className="cursor-pointer text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Show full revision</summary>
        <dl className="mt-1 grid min-w-0 gap-1 border-l pl-2">
          {entries.map(([label, full]) => <div className="min-w-0" key={label}><dt className="text-muted-foreground">{label}</dt><dd><code className="block break-all">{full}</code></dd></div>)}
        </dl>
      </details>
    </div>
  );
}
