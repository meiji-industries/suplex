import { Alert, AlertDescription } from "../../components/ui/alert.js";
import type { ApiCompany } from "../../lib/api.js";
import { useState, type ReactElement } from "react";
import type { ApiProfile, ApiProject } from "../../shell/view-shared.js";
import { CreateProjectDialog } from "./create-project-dialog.js";
import { SettingsContent } from "../settings/settings-layout.js";

import { ProjectCards } from "./project-cards.js";
import { RecentRepositories } from "./recent-repositories.js";
import { LoadingState } from "../../components/app/loading-state.js";

type ProjectsContentProps = {
  currentCompany: ApiCompany | undefined;
  projects: readonly ApiProject[];
  agents: readonly ApiProfile[];
  loading: boolean;
  projectsLoading: boolean;
  loadError: string;
  companyError?: string | undefined;
  canSignInToGitHub: boolean;
  reload: () => Promise<void>;
  reloadCompanies: () => Promise<void>;
};

export function ProjectsContent({ currentCompany, projects, agents, loading, projectsLoading, loadError, companyError, canSignInToGitHub, reload, reloadCompanies }: ProjectsContentProps): ReactElement {
  const companyId = currentCompany?.id ?? "";
  const [createOpen, setCreateOpen] = useState(false);
  return <>
        <SettingsContent width="wide" title="Projects" description="A project connects a repository to Suplex.">
          {currentCompany && currentCompany.status !== "active" ? <p className="mb-3 text-xs text-muted-foreground">{currentCompany.status === "paused" ? "Company paused. New projects are not available." : "Company archived. New projects are not available."}</p> : null}
          {currentCompany ? (
            <div className="grid gap-3">
              {!loadError && projectsLoading ? <LoadingState /> : null}
              <ProjectCards projects={projects} agents={agents} onAdd={!loading && !projectsLoading && currentCompany.status === "active" ? () => setCreateOpen(true) : undefined} />

              <RecentRepositories companyId={companyId} projects={projects} canSignInToGitHub={canSignInToGitHub} onAdded={() => setCreateOpen(false)} onCreated={reload} />
            </div>
          ) : loading ? <LoadingState /> : <p className="text-xs text-muted-foreground">{companyError ? "Unable to load companies" : canSignInToGitHub ? "Add a company to begin." : "No company access. Ask an administrator to assign a company."}</p>}
          {loadError ? <div className="mt-3 text-xs text-destructive"><Alert variant="destructive"><AlertDescription>{loadError}</AlertDescription></Alert></div> : null}
        </SettingsContent>
        <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} companyId={companyId} companyStatus={currentCompany?.status} canSignInToGitHub={canSignInToGitHub} onCreated={reload} reloadCompanies={reloadCompanies} />
  </>;
}
