import { Check, ChevronRight, Copy } from "lucide-react";
import { useState, type ReactElement } from "react";

import { Button } from "../ui/button.js";
import { Collapsible } from "../ui/collapsible.js";
import { CommitSha } from "./commit-sha.js";

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

export function RevisionIdentity({ revision, repository }: { revision: Revision; repository?: string | undefined }): ReactElement {
  const entries = [
    ["base", revision.baseSha, revision.baseShaAbbrev, true],
    ["head", revision.subjectCommit, revision.subjectCommitAbbrev, true],
    ["tree", revision.subjectTree, revision.subjectTreeAbbrev, false],
  ] as const;
  return (
    <Collapsible.Root className="group min-w-0 text-[11px]">
      <Collapsible.Trigger className="flex items-center gap-1 text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight className="size-3 transition-transform group-data-[panel-open]:rotate-90" aria-hidden="true" />
        <span>Debug</span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="mt-1 space-y-1">
        {entries.map(([label, full, abbreviated, isCommit]) => (
          <div className="flex min-w-0 items-center gap-1.5" key={label}>
            <span className="w-8 shrink-0 text-muted-foreground">{label}</span>
            {isCommit ? <CommitSha sha={full} abbreviated={abbreviated} repository={repository} className="min-w-0 flex-1 truncate" /> : <code className="min-w-0 flex-1 truncate" title={full}>{abbreviated}</code>}
            <CopyValue label={label} value={full} />
          </div>
        ))}
        <details className="min-w-0">
          <summary className="cursor-pointer text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Show full revision</summary>
          <dl className="mt-1 grid min-w-0 gap-1 border-l pl-2">
            {entries.map(([label, full, , isCommit]) => <div className="min-w-0" key={label}><dt className="text-muted-foreground">{label}</dt><dd>{isCommit ? <CommitSha sha={full} abbreviated={full} repository={repository} className="block break-all" /> : <code className="block break-all">{full}</code>}</dd></div>)}
          </dl>
        </details>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
