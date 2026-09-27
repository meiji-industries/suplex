import { useEffect, useState, type ReactNode } from "react";

import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { SettingsDataTable, SettingsTableCell, SettingsTableGroup, SettingsTableRow, type SettingsTableColumn } from "../../components/app/settings-table.js";
import { Button } from "../../components/ui/button.js";
import { Spinner } from "../../components/ui/spinner.js";
import type { RecentRepository } from "../../contracts/generated/RecentRepository.js";
import { GithubDeviceSignIn } from "../../components/app/github-device-sign-in.js";
import { hasApiFinding } from "../../lib/api.js";
import { relativeTime, type ApiProject } from "../../shell/view-shared.js";
import { SettingsSectionHeader } from "../settings/settings-layout.js";
import { createProject, listRecentRepositories } from "./lib/project-api.js";
import { Plus } from "lucide-react";

const RECENT_REPOSITORY_COLUMNS: SettingsTableColumn[] = [
  { key: "repository", label: "Repository", width: 145 },
  { key: "pushed", label: "Pushed", width: 65 },
  { key: "add", width: 100 },
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
  if (!suggestions.length && !error) return fallback ?? null;

  const add = async (each: RecentRepository): Promise<void> => {
    setAdding(current => [...current, each.repository]);
    setError("");
    setGithubAuthRequired(false);
    try {
      await createProject(companyId, { repositoryUrl: `https://github.com/${each.repository}`, baseBranch: each.defaultBranch, integration: { repository: { kind: "github" }, tracker: null } });
    } catch (reason) {
      if (hasApiFinding(reason, "github-auth-unavailable")) setGithubAuthRequired(true);
      else setError(reason instanceof Error ? reason.message : `Suplex could not add ${each.repository}.`);
      setAdding(current => current.filter(name => name !== each.repository));
      return;
    }
    setRepositories(current => current?.filter(repository => repository.repository !== each.repository) ?? current);
    onAdded?.();
    try {
      await onCreated();
    } catch {
      setError("The project was added. Suplex could not refresh projects. Select Check again.");
    } finally {
      setAdding(current => current.filter(name => name !== each.repository));
    }
  };

  return (
    <section aria-label="Recent repositories" className="mt-12 space-y-2">
      <SettingsSectionHeader title="Add a recent repository" description="Add a GitHub repository that you recently used." />
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      {githubAuthRequired ? <Alert><AlertDescription><div className="space-y-2"><p>GitHub is not signed in.</p>{canSignInToGitHub ? <GithubDeviceSignIn onConnected={async () => { const result = await listRecentRepositories(companyId); setRepositories(result); setGithubAuthRequired(false); }} /> : <p>An administrator must sign in to GitHub.</p>}</div></AlertDescription></Alert> : null}
      {suggestions.length ? (
        <SettingsDataTable label="Recent repositories" columns={RECENT_REPOSITORY_COLUMNS}>
          <SettingsTableGroup label="Recent repositories" count={suggestions.length} columnCount={RECENT_REPOSITORY_COLUMNS.length}>
            {suggestions.map(each => {
              const busy = adding.includes(each.repository);
              return (
                <SettingsTableRow key={each.repository}>
                  <SettingsTableCell className="truncate font-medium">{each.repository}</SettingsTableCell>
                  <SettingsTableCell className="whitespace-nowrap text-xs text-muted-foreground">{pushedAgo(each.pushedAt)}</SettingsTableCell>
                  <SettingsTableCell className="text-right"><Button size="xs" variant="outline" disabled={busy} onClick={() => void add(each)} aria-label={`Add ${each.repository}`}>{busy ? <Spinner /> : <Plus />}Add Project</Button></SettingsTableCell>
                </SettingsTableRow>
              );
            })}
          </SettingsTableGroup>
        </SettingsDataTable>
      ) : null}
    </section>
  );
}
