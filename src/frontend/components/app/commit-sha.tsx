import type { ReactElement } from "react";

import { cn } from "../../lib/utils.js";

export function CommitSha({ sha, abbreviated, repository, className }: { sha: string | null | undefined; abbreviated?: string | null; repository?: string | null | undefined; className?: string }): ReactElement {
  if (!sha) return <span className={className}>{abbreviated ?? "—"}</span>;
  const label = abbreviated ?? `${sha.slice(0, 8)}…`;
  const classNames = cn("font-mono", className);
  return repository ? <a className={cn("text-primary underline underline-offset-2", classNames)} href={`https://github.com/${repository}/commit/${sha}`} target="_blank" rel="noreferrer" title={sha}>{label}</a> : <code className={classNames} title={sha}>{label}</code>;
}
