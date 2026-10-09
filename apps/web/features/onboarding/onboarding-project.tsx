import { useEffect, useState, type ReactElement } from "react";

import { GithubDeviceSignIn } from "../../components/app/github-device-sign-in.js";
import type { RecentRepository } from "../../contracts/generated/RecentRepository.js";
import { ApiError, hasApiFinding, withCompany } from "../../lib/api.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { CreateProjectDialog } from "../projects/create-project-dialog.js";
import { createProject, listRecentRepositories } from "../projects/lib/project-api.js";
import { OnboardingFrame, PrimaryButton } from "./onboarding-frame.js";
import { startTrialIfAvailable, stepComplete, type ApiProject, type OnboardingData } from "./onboarding.js";
import type { StepProps } from "./onboarding-wizard.js";
import branchesHtml from "./motion/m24.html?raw";

// Created once: a new object on each render makes React rewrite the HTML and restart its animation.
const branches = { __html: branchesHtml };

function pushedAgo(timestamp: string): string {
  const days = Math.floor((Date.now() - Date.parse(timestamp)) / 86_400_000);
  if (days < 1) return "today";
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

const BRANCH = <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ededed" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="15" r="2" /><path d="M6 7v10M18 13V9a2 2 0 0 0-2-2h-3" /></svg>;

function SelectedProject({ project }: { project: ApiProject }): ReactElement {
  const tracker = project.integration?.tracker;
  return <div className="repo-on">
    <div className="row">
      {BRANCH}
      <span style={{ fontSize: 15, fontWeight: 500, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{project.repository ?? project.name}</span>
      <span className="pill p-mute">{project.baseBranch}</span>
      <span style={{ flex: 1 }} />
      <span className="pill p-lime">Selected</span>
    </div>
    <div className="row t12 dim"><span className="mono" style={{ textTransform: "none", letterSpacing: 0, overflowWrap: "anywhere" }}>{project.repositoryPath}</span></div>
    <div className="row t12" style={{ flexWrap: "wrap" }}>
      <span className="dim">Issue tracker</span>
      <span className="pill p-mute">{tracker?.kind === "github" ? "GitHub Issues" : tracker?.kind === "jira" ? "Jira" : tracker?.kind === "linear" ? "Linear" : "None"}</span>
      <a className="dimmer" style={{ color: "inherit" }} href={withCompany(`/projects/${encodeURIComponent(project.id)}`, project.companyId)}>{tracker ? "Change in project settings" : "Connect GitHub Issues, Jira or Linear"}</a>
    </div>
  </div>;
}

export function ProjectStep({ onBack, onNext, data }: StepProps & { data: OnboardingData }): ReactElement {
  const { currentCompany, user, reloadCompanies } = useCompanyContext();
  const companyId = currentCompany?.id ?? "";
  const { state, reload } = data;
  const [repositories, setRepositories] = useState<RecentRepository[] | null>(null);
  const [adding, setAdding] = useState<string>();
  const [error, setError] = useState("");
  const [githubAuthRequired, setGithubAuthRequired] = useState(false);
  const [creating, setCreating] = useState(false);
  const loadRepositories = (): void => {
    if (!companyId) return;
    void listRecentRepositories(companyId).then(result => setRepositories(result.repositories)).catch(() => setRepositories([]));
  };
  useEffect(loadRepositories, [companyId]);
  const known = new Set(state.projects.flatMap(project => project.repository ? [project.repository.toLowerCase()] : []));
  const suggestions = (repositories ?? []).filter(each => !known.has(each.repository.toLowerCase())).slice(0, 6);

  const add = async (each: RecentRepository): Promise<void> => {
    setAdding(each.repository);
    setError("");
    setGithubAuthRequired(false);
    const body = { repositoryUrl: `https://github.com/${each.repository}`, baseBranch: each.defaultBranch, integration: { repository: { kind: "github" as const }, tracker: { kind: "github" as const, repository: each.repository } } };
    try {
      try {
        await createProject(companyId, body);
      } catch (reason) {
        // A company named before the trial existed can still meet the Free limit here: start the trial, then add again.
        if (!(reason instanceof ApiError && reason.code === "project_limit_reached") || !await startTrialIfAvailable().catch(() => false)) throw reason;
        await createProject(companyId, body);
      }
      await reload();
    } catch (reason) {
      if (hasApiFinding(reason, "github-auth-unavailable")) setGithubAuthRequired(true);
      else setError(reason instanceof ApiError && reason.findings?.length ? reason.findings.map(finding => finding.message).join(" ") : reason instanceof Error ? reason.message : `Suplex could not add ${each.repository}.`);
    } finally {
      setAdding(undefined);
    }
  };

  return <OnboardingFrame step="project" onBack={onBack} bodyClassName="s-split" action={<PrimaryButton disabled={!stepComplete(state, "project")} onClick={onNext}>Continue</PrimaryButton>}>
    <div className="s-col" style={{ width: 580, gap: 20 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h1 className="h2">Pick a repo.</h1>
        <p className="sub">A project connects a repository to Suplex. Each task works in its own branch, so main stays clean.</p>
      </div>
      {state.projects.map(project => <SelectedProject key={project.id} project={project} />)}
      {githubAuthRequired ? <div className="repo-on" style={{ borderColor: "#80612a", background: "#1a140a" }}>
        <span style={{ fontSize: 14 }}>Sign in to GitHub to add a repository.</span>
        {user?.role === "admin" ? <div><GithubDeviceSignIn onConnected={async () => { setGithubAuthRequired(false); loadRepositories(); }} /></div> : <span className="dim t12">An administrator must sign in to GitHub.</span>}
      </div> : null}
      {suggestions.length || repositories === null ? <>
        <div className="mono dimmer" style={{ fontSize: 10, display: "flex", justifyContent: "space-between" }}><span>Your repos</span><span>Last pushed</span></div>
        <div className="repos" aria-label="Your repos" aria-busy={repositories === null}>
          {repositories === null ? <div className="rp dim">Loading your GitHub repositories…</div> : suggestions.map(each => <div key={each.repository} className="rp">
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{each.repository}</span>
            <span className="w">{pushedAgo(each.pushedAt)}</span>
            <button className="btn2" type="button" style={{ height: 30, fontSize: 12, padding: "0 12px" }} disabled={adding !== undefined} aria-label={`Add ${each.repository}`} onClick={() => void add(each)}>{adding === each.repository ? "Adding…" : "+ Add"}</button>
          </div>)}
        </div>
      </> : null}
      <button className="back" type="button" style={{ alignSelf: "flex-start", fontSize: 14, color: "#cfcfcf" }} onClick={() => setCreating(true)}>+ {suggestions.length || state.projects.length ? "Start a fresh repo" : "Add a repository"}</button>
      {error || data.error ? <p className="error" role="alert">{error || data.error}</p> : null}
    </div>
    <div className="m24 preview-wrap" aria-hidden="true" dangerouslySetInnerHTML={branches} />
    <CreateProjectDialog open={creating} onOpenChange={setCreating} companyId={companyId} companyStatus={currentCompany?.status} canSignInToGitHub={user?.role === "admin"} onCreated={reload} reloadCompanies={reloadCompanies} />
  </OnboardingFrame>;
}
