import { useEffect, useRef, useState, type ReactNode } from "react";

import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { SettingsDataTable, SettingsTableCell, SettingsTableGroup, SettingsTableRow, type SettingsTableColumn } from "../../components/app/settings-table.js";
import { Button } from "../../components/ui/button.js";
import { Avatar, AvatarFallback, AvatarImage } from "../../components/ui/avatar.js";
import { Spinner } from "../../components/ui/spinner.js";
import type { RecentRepository } from "../../contracts/generated/RecentRepository.js";
import { GithubDeviceSignIn } from "../../components/app/github-device-sign-in.js";
import { hasApiFinding } from "../../lib/api.js";
import { relativeTime, type ApiProject } from "../../shell/view-shared.js";
import { createProject, listRecentRepositories } from "./lib/project-api.js";
import { Plus } from "lucide-react";

const RECENT_REPOSITORY_COLUMNS: SettingsTableColumn[] = [
  { key: "repository", label: "Your Repos" },
  { key: "pushed", label: "Last Pushed At", width: 140 },
  { key: "add", width: 130 },
];

function pushedAgo(timestamp: string): string {
  const days = Math.floor((Date.now() - Date.parse(timestamp)) / 86_400_000);
  return days ? `${days}d` : relativeTime(timestamp).replace(" ago", "");
}

/** GitHub repositories pushed to recently that are not projects yet, each with a one-click add. */
export function RecentRepositories({ companyId, projects, canSignInToGitHub, onCreated, onAdded, fallback }: { companyId: string; projects: readonly ApiProject[]; canSignInToGitHub: boolean; onCreated: () => Promise<void>; onAdded?: () => void; fallback?: ReactNode }): ReactNode {
  const [repositories, setRepositories] = useState<RecentRepository[] | null>(null);
  const [adding, setAdding] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [githubAuthRequired, setGithubAuthRequired] = useState(false);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);
  const pageRequest = useRef(false);
  useEffect(() => {
    const token = ++generation.current;
    setRepositories(null);
    setNextPage(null);
    setLoadingMore(false);
    pageRequest.current = false;
    setAdding([]);
    setError("");
    setGithubAuthRequired(false);
    if (!companyId) return;
    // Suggestions are optional: when GitHub cannot list them, show the fallback.
    void listRecentRepositories(companyId).catch(() => ({ repositories: [], nextPage: null })).then(result => {
      if (generation.current !== token) return;
      setRepositories(result.repositories);
      setNextPage(result.nextPage);
    });
    return () => { ++generation.current; };
  }, [companyId]);

  const loadMore = async (): Promise<void> => {
    if (nextPage === null || pageRequest.current) return;
    const token = generation.current;
    pageRequest.current = true;
    setLoadingMore(true);
    setError("");
    try {
      const result = await listRecentRepositories(companyId, nextPage);
      if (generation.current !== token) return;
      setRepositories(current => {
        const names = new Set(current?.map(each => each.repository.toLowerCase()));
        return [...(current ?? []), ...result.repositories.filter(each => {
          const name = each.repository.toLowerCase();
          if (names.has(name)) return false;
          names.add(name);
          return true;
        })];
      });
      setNextPage(result.nextPage);
    } catch {
      if (generation.current === token) setError("Suplex could not load repositories. Select Load more to retry.");
    } finally {
      if (generation.current === token) {
        pageRequest.current = false;
        setLoadingMore(false);
      }
    }
  };

  const resetAfterSignIn = async (): Promise<void> => {
    const token = ++generation.current;
    setRepositories(null);
    setNextPage(null);
    setLoadingMore(false);
    pageRequest.current = false;
    setError("");
    setGithubAuthRequired(false);
    try {
      const result = await listRecentRepositories(companyId);
      if (generation.current !== token) return;
      setRepositories(result.repositories);
      setNextPage(result.nextPage);
    } catch {
      if (generation.current !== token) return;
      setRepositories([]);
      setNextPage(1);
      setError("Suplex could not load repositories. Select Load more to retry.");
    }
  };
  const known = new Set(projects.flatMap(project => project.repository ? [project.repository.toLowerCase()] : []));
  const suggestions = repositories?.filter(each => !known.has(each.repository.toLowerCase())) ?? [];
  if (repositories === null) return null;
  if (!suggestions.length && !error && !githubAuthRequired && nextPage === null) return fallback ?? null;

  const add = async (each: RecentRepository): Promise<void> => {
    const token = generation.current;
    setAdding(current => [...current, each.repository]);
    setError("");
    setGithubAuthRequired(false);
    try {
      await createProject(companyId, { repositoryUrl: `https://github.com/${each.repository}`, baseBranch: each.defaultBranch, integration: { repository: { kind: "github" }, tracker: null } });
    } catch (reason) {
      if (generation.current !== token) return;
      if (hasApiFinding(reason, "github-auth-unavailable")) setGithubAuthRequired(true);
      else setError(reason instanceof Error ? reason.message : `Suplex could not add ${each.repository}.`);
      setAdding(current => current.filter(name => name !== each.repository));
      return;
    }
    if (generation.current !== token) return;
    setRepositories(current => current?.filter(repository => repository.repository !== each.repository) ?? current);
    onAdded?.();
    try {
      await onCreated();
    } catch {
      if (generation.current === token) setError("The project was added. Suplex could not refresh projects. Select Check again.");
    } finally {
      if (generation.current === token) setAdding(current => current.filter(name => name !== each.repository));
    }
  };

  return (
    <section aria-label="Recent repositories" className="mt-3 min-w-0 space-y-2">
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      {githubAuthRequired ? <Alert><AlertDescription><div className="space-y-2"><p>GitHub is not signed in.</p>{canSignInToGitHub ? <GithubDeviceSignIn onConnected={resetAfterSignIn} /> : <p>An administrator must sign in to GitHub.</p>}</div></AlertDescription></Alert> : null}
      {suggestions.length ? (
        <SettingsDataTable label="Recent repositories" columns={RECENT_REPOSITORY_COLUMNS} minWidth={0}>
          <SettingsTableGroup label="Recent repositories" count={suggestions.length} columnCount={RECENT_REPOSITORY_COLUMNS.length}>
            {suggestions.map(each => {
              const busy = adding.includes(each.repository);
              return (
                <SettingsTableRow key={each.repository}>
                  <SettingsTableCell><span className="flex min-w-0 items-center gap-2"><Avatar size="xs"><AvatarImage src={each.ownerAvatarUrl ?? undefined} alt="" /><AvatarFallback>{each.repository[0]?.toUpperCase() ?? "?"}</AvatarFallback></Avatar><span className="truncate font-medium">{each.repository}</span></span></SettingsTableCell>
                  <SettingsTableCell className="whitespace-nowrap text-xs text-muted-foreground">{pushedAgo(each.pushedAt)}</SettingsTableCell>
                  <SettingsTableCell className="text-right"><Button size="xs" variant="outline" disabled={busy} onClick={() => void add(each)} aria-label={`Add ${each.repository}`}>{busy ? <Spinner /> : <Plus />}Add Project</Button></SettingsTableCell>
                </SettingsTableRow>
              );
            })}
          </SettingsTableGroup>
        </SettingsDataTable>
      ) : null}
      {nextPage !== null ? <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? <Spinner /> : null}Load more</Button> : null}
    </section>
  );
}
