import { useEffect, useState, type ReactNode } from "react";

import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Spinner } from "../../components/ui/spinner.js";
import type { RecentRepository } from "../../contracts/generated/RecentRepository.js";
import { relativeTime, type ApiProject } from "../../shell/view-shared.js";
import { createProject, listRecentRepositories } from "./lib/project-api.js";

function pushedAgo(timestamp: string): string {
  const days = Math.floor((Date.now() - Date.parse(timestamp)) / 86_400_000);
  return days ? `${days}d ago` : relativeTime(timestamp);
}

/** GitHub repositories pushed to recently that are not projects yet, each with a one-click add. */
export function RecentRepositories({ companyId, projects, onCreated, fallback }: { companyId: string; projects: readonly ApiProject[]; onCreated: () => Promise<void>; fallback?: ReactNode }): ReactNode {
  const [repositories, setRepositories] = useState<RecentRepository[] | null>(null);
  const [adding, setAdding] = useState<string[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!companyId) return;
    let closed = false;
    // Suggestions are optional: when GitHub cannot list them, show the fallback.
    void listRecentRepositories(companyId).catch(() => []).then(result => { if (!closed) setRepositories(result); });
    return () => { closed = true; };
  }, [companyId]);
  const known = new Set(projects.flatMap(project => project.repository ? [project.repository.toLowerCase()] : []));
  const suggestions = repositories?.filter(each => !known.has(each.repository.toLowerCase())) ?? [];
  if (repositories === null) return null;
  if (!suggestions.length) return fallback ?? null;

  const add = async (each: RecentRepository): Promise<void> => {
    setAdding(current => [...current, each.repository]);
    setError("");
    try {
      await createProject(companyId, { repositoryUrl: `https://github.com/${each.repository}`, baseBranch: each.defaultBranch, integration: { repository: { kind: "github" }, tracker: null } });
      await onCreated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Suplex could not add ${each.repository}.`);
    } finally {
      setAdding(current => current.filter(name => name !== each.repository));
    }
  };

  return (
    <section aria-label="Recent repositories" className="space-y-1">
      <h3 className="text-xs font-medium text-muted-foreground">Recent repositories</h3>
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <ul>
        {suggestions.map(each => {
          const busy = adding.includes(each.repository);
          return (
            <li key={each.repository} className="flex min-h-9 items-center gap-3 border-b">
              <span className="min-w-0 flex-1 truncate text-sm">{each.repository}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{pushedAgo(each.pushedAt)}</span>
              <Button size="xs" variant="outline" disabled={busy} onClick={() => void add(each)} aria-label={`Add ${each.repository}`}>{busy ? <Spinner /> : null}Add</Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
