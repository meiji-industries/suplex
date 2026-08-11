import { Collapsible } from "./components/ui/collapsible.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { Dialog } from "./components/ui/dialog.js";
import { ApplicationFrame } from "./components/app/application-frame.js";
import { CompanyProvider, useCompanyContext } from "./components/app/company-context.js";
import { readJson, withCompany, type ApiUser, type CompanyStatus } from "./lib/api.js";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { HealthCheck, HealthSnapshot } from "../health.js";
import { isOwnedHealthCheck } from "../health-contract.js";
import {
  Activity,
  Archive,
  ChevronRight,
  CircleHelp,
  Clock3,
  Database,
  GitBranch,
  HardDrive,
  RefreshCw,
  RotateCcw,
  Save,
  Terminal,
  Pause,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

const icons: Record<string, LucideIcon> = {
  temporal: Workflow,
  database: Database,
  "artifact-root": HardDrive,
  worker: Activity,
  "codex-auth": Terminal,
  "gh-auth": GitBranch,
};

function relativeTime(timestamp: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(timestamp));
  if (elapsed < 10_000) return "just now";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s ago`;
  return `${Math.floor(elapsed / 60_000)}m ago`;
}

type ApiProfile = { id: string; name: string; model: string; reasoningLevel: string; servicePriority: string; capacity: number };
type ApiProject = { id: string; companyId: string; name: string; repositoryPath: string; worktreeRoot: string; repository?: string; baseBranch: string; targetBranch: string; setupCommand: string; verificationCommand: string; requiredChecks: string[]; allowedProfileIds: string[]; roleDefaults: Record<string, string>; status: string; configurationRevision: number; configurationIdentity?: string };
type ApiAttentionItem = { id: string; companyId: string; taskId: string; taskTitle: string; category: string; summary: string; action: string; evidenceRef?: string; updatedAt: string };
type ApiAttentionCompany = { companyId: string; companyName: string; companyStatus: string; activeIssueCount: number; phases: Record<string, number>; attentionCount: number; attention: ApiAttentionItem[]; recentOutcomes: Array<{ taskId: string; taskTitle: string; phase: string; updatedAt: string }> };
type ApiTask = { id: string; companyId: string; projectId: string; title: string; description: string; briefArtifactId: string; images: Array<{ artifactId: string; filename: string; mimeType: string; byteSize: number }>; roleProfiles: Record<string, string>; supplementalReview: boolean; workflowId: string; projectRevisionId: string; phase: "backlog" | "planning" | "approval" | "ready_for_development" | "development" | "delivery_ready" | "reviewing_delivery" | "repair_required" | "delivery_reviewed" | "delivery_blocked"; revision: number; owner: "human" | "lead"; allowedCommands: string[]; pendingAction: string | null; createdAt: string; updatedAt: string; timeline: Array<{ id: string; revision: number; eventType: string; metadata: Record<string, string | number | boolean>; createdAt: string }>; planRevision?: number | null; planMaterial?: boolean | null; materialCategories?: string[]; supplementalReviewUsed?: boolean; supplementalReviewArtifactId?: string | null; decisionId?: string | null; deliveryReview?: { id: string; outcome: "approved" | "blocking"; summary: string; planRevision: number; baseSha: string; subjectCommit: string; subjectTree: string; findings: Array<{ id: string; severity: "blocking" | "advisory"; rationale: string; evidenceRef: string; disposition: string; repairInstruction: string | null }> }; developerExecution?: { id: string; status: string; attempt: number; branchName: string; worktreePath: string; targetBaseSha: string; resultCommit?: string | null; resultTree?: string | null; dirtyState?: string | null; deliveryArtifactId?: string | null; deliverySummary?: string | null }; leadOutput?: { kind: "plan" | "decision_blocker"; summary: string; sessionRef: string; executionId: string; outputArtifactId: string; evidenceArtifactId: string; content: { kind: "plan"; summary: string; reproduction: string | null; rootCauseAnalysis: string | null; steps: Array<{ number: number; instruction: string; verification: string }>; compatibilityAnalysis: string; operationalAnalysis: string; verificationStrategy: string; unresolvedTechnicalQuestions: string[] } | { kind: "decision_blocker"; summary: string; evidence: string; owner: "human"; question: string; nextAction: string } } };

function AuthView(): ReactElement {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [required, setRequired] = useState(false);
  const [token, setToken] = useState(params.get("invite") ?? "");
  const mode = params.get("mode") ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void readJson<{ required: boolean; authenticated: boolean }>("/api/auth/status").then((status) => {
      if (status.authenticated) window.location.assign("/health");
      setRequired(status.required);
    }).catch(() => setError("Unable to read sign-in state"));
  }, []);

  const enroll = async (): Promise<void> => {
    setBusy(true); setError("");
    try {
      const registrationKind = mode === "recovery" ? "recovery" : required ? "bootstrap" : "invitation";
      const options = await readJson<{ challengeId: string; options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>(`/api/auth/${registrationKind}/options`, { method: "POST", body: JSON.stringify({ token }) });
      const response = await startRegistration({ optionsJSON: options.options });
      await readJson(`/api/auth/${registrationKind}/verify`, { method: "POST", body: JSON.stringify({ token, challengeId: options.challengeId, response }) });
      window.location.assign("/health");
    } catch {
      setError("Passkey enrollment failed");
    } finally { setBusy(false); }
  };

  const signIn = async (): Promise<void> => {
    setBusy(true); setError("");
    try {
      const options = await readJson<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>("/api/auth/options", { method: "POST", body: "{}" });
      const response = await startAuthentication({ optionsJSON: options.options });
      await readJson("/api/auth/verify", { method: "POST", body: JSON.stringify({ challengeId: options.challengeId, response }) });
      window.location.assign("/health");
    } catch {
      setError("Passkey sign-in failed");
    } finally { setBusy(false); }
  };

  const enrollment = required || token.length > 0;
  return (
    <ApplicationFrame title={enrollment ? "Enroll passkey" : "Sign in"}>
      <div className="mx-auto max-w-md px-4 py-4 sm:px-8">
        <div className="border border-border bg-card p-4">
          <div className="mb-5 flex items-center justify-between"><span className="text-[13px] font-semibold">{enrollment ? "Passkey enrollment" : "Passkey sign-in"}</span><span className="text-xs text-muted-foreground">No password</span></div>
          {enrollment ? <><label className="mb-1 block text-xs text-muted-foreground" htmlFor="invitation">Invitation token</label><Input id="invitation" className="mb-3 w-full" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} /><Button className="w-full" onClick={() => void enroll()} disabled={busy || token.length < 16}>{busy ? "Waiting for passkey…" : "Enroll passkey"}</Button></> : <Button className="w-full" onClick={() => void signIn()} disabled={busy}>{busy ? "Waiting for passkey…" : "Sign in with passkey"}</Button>}
          {error ? <p role="alert" className="mt-3 text-xs text-rose-700">{error}</p> : null}
        </div>
      </div>
    </ApplicationFrame>
  );
}

function AdminView(): ReactElement {
  const { user, companies, loading } = useCompanyContext();
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [profileName, setProfileName] = useState("");
  const [profileModel, setProfileModel] = useState("gpt-5-codex");
  const [profileReasoning, setProfileReasoning] = useState("medium");
  const [profilePriority, setProfilePriority] = useState("standard");
  const [profileCapacity, setProfileCapacity] = useState("2");
  const [inviteToken, setInviteToken] = useState("");
  const [error, setError] = useState("");

  const reload = useCallback(async (): Promise<void> => {
    try {
      const userList = await readJson<{ users: ApiUser[] }>("/api/admin/users");
      const profileList = await readJson<{ profiles: ApiProfile[] }>("/api/profiles").catch(() => ({ profiles: [] }));
      setUsers(userList.users); setProfiles(profileList.profiles);
    } catch (reason) {
      if (reason instanceof Error && reason.message === "Authentication required") window.location.assign("/auth");
      else setError("Unable to load administration");
    }
  }, []);
  useEffect(() => { if (!loading && user?.role === "admin") void reload(); }, [loading, reload, user?.role]);

  const invite = async (): Promise<void> => {
    try { const result = await readJson<{ token: string }>("/api/admin/invitations", { method: "POST", body: JSON.stringify({ displayName: displayName || "Forge user" }) }); setInviteToken(result.token); setDisplayName(""); await reload(); } catch { setError("Unable to invite user"); }
  };
  const createProfile = async (): Promise<void> => {
    try { await readJson("/api/admin/profiles", { method: "POST", body: JSON.stringify({ name: profileName, model: profileModel, reasoningLevel: profileReasoning, servicePriority: profilePriority, capacity: Number(profileCapacity) }) }); setProfileName(""); await reload(); } catch { setError("Unable to create profile"); }
  };
  const changeMembership = async (companyId: string, targetUserId: string, add: boolean): Promise<void> => {
    try {
      const init: RequestInit = { method: add ? "POST" : "DELETE" };
      if (add) init.body = JSON.stringify({ userId: targetUserId });
      await readJson(add ? `/api/admin/companies/${companyId}/members` : `/api/admin/companies/${companyId}/members/${targetUserId}`, init);
      await reload();
    } catch { setError("Unable to change membership"); }
  };
  const signOut = async (): Promise<void> => { await readJson("/api/auth/sign-out", { method: "POST", body: "{}" }); window.localStorage.removeItem("forge.activeCompanyId"); window.location.assign("/auth"); };

  if (loading) {
    return <ApplicationFrame title="Administration"><div className="p-4 text-xs text-muted-foreground">Loading administration…</div></ApplicationFrame>;
  }
  if (user?.role !== "admin") {
    return <ApplicationFrame title="Administration"><div className="p-4 text-xs text-muted-foreground">Administration is unavailable.</div></ApplicationFrame>;
  }

  return (
    <ApplicationFrame title="Administration">
      <div className="divide-y divide-border/70">
        <section className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-3 py-3 sm:px-4"><span className="text-xs text-muted-foreground">{user?.displayName ?? ""} · {user?.role ?? ""}</span><Button variant="ghost" size="sm" onClick={() => void signOut()}>Sign out</Button></section>
        <section className="grid gap-px border-b border-border/70 bg-border sm:grid-cols-2">
          <div className="bg-background p-4"><div className="mb-3 flex items-center justify-between"><span className="text-xs font-semibold">Users</span><span className="text-[11px] text-muted-foreground">{users.length}</span></div><div className="mb-3 flex gap-2"><Input className="h-7 flex-1" placeholder="Display name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /><Button size="sm" onClick={() => void invite()}>Invite</Button></div>{inviteToken ? <code className="block break-all border border-border bg-muted/30 p-2 text-[11px]">{inviteToken}</code> : null}<div className="mt-3 divide-y divide-border/70 border-y border-border/70">{users.map((candidate) => <div className="flex min-h-8 items-center justify-between gap-2 text-xs" key={candidate.id}><span className="truncate">{candidate.displayName} <span className="text-muted-foreground">{candidate.status}</span></span>{candidate.role !== "admin" && candidate.status === "active" ? <Button variant="ghost" size="sm" onClick={() => void readJson(`/api/admin/users/${candidate.id}/revoke`, { method: "POST", body: "{}" }).then(() => reload()).catch(() => setError("Unable to revoke user"))}>Revoke</Button> : null}</div>)}</div></div>
          <div className="bg-background p-4"><div className="mb-3 flex items-center justify-between"><span className="text-xs font-semibold">Companies</span><span className="text-[11px] text-muted-foreground">{companies.length}</span></div><div className="divide-y divide-border/70 border-y border-border/70">{companies.map((company) => <div className="py-2 text-xs" key={company.id}><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><span className="min-w-0 truncate"><span>{company.name}</span> <span className="text-muted-foreground">{company.status}</span></span><a className="flex h-7 items-center px-2 text-xs text-muted-foreground hover:text-foreground" href={withCompany(`/companies/${encodeURIComponent(company.id)}/settings`, company.id)}>Settings</a></div><div className="flex flex-wrap gap-1.5">{users.filter((candidate) => candidate.role === "member" && candidate.status === "active").map((candidate) => { const assigned = candidate.companyIds.includes(company.id); return <Button key={candidate.id} variant={assigned ? "secondary" : "outline"} size="sm" onClick={() => void changeMembership(company.id, candidate.id, !assigned)}>{assigned ? "− " : "+ "}{candidate.displayName}</Button>; })}</div></div>)}</div></div>
        </section>
        <section className="border-b border-border/70 bg-background p-4"><div className="mb-3 flex items-center justify-between"><span className="text-xs font-semibold">Codex profiles</span><span className="text-[11px] text-muted-foreground">{profiles.length} configured</span></div><div className="mb-3 flex flex-wrap gap-2"><Input className="h-7 w-36" placeholder="Profile name" value={profileName} onChange={(event) => setProfileName(event.target.value)} /><Input className="h-7 w-36" placeholder="Model" value={profileModel} onChange={(event) => setProfileModel(event.target.value)} /><Input className="h-7 w-20" aria-label="Reasoning level" placeholder="Reasoning" value={profileReasoning} onChange={(event) => setProfileReasoning(event.target.value)} /><Input className="h-7 w-24" aria-label="Service priority" placeholder="Priority" value={profilePriority} onChange={(event) => setProfilePriority(event.target.value)} /><Input className="h-7 w-20" placeholder="Capacity" inputMode="numeric" value={profileCapacity} onChange={(event) => setProfileCapacity(event.target.value)} /><Button size="sm" onClick={() => void createProfile()}>Create profile</Button></div><div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">{profiles.map((profile) => <span className="border border-border px-2 py-1" key={profile.id}>{profile.name} · {profile.model} · {profile.reasoningLevel} · {profile.servicePriority} · {profile.capacity} slots · {profile.id}</span>)}</div></section>
        {error ? <p role="alert" className="px-4 py-3 text-xs text-rose-700">{error}</p> : null}
      </div>
    </ApplicationFrame>
  );
}

function ProjectsView(): ReactElement {
  const { currentCompany, loading, user, error: companyError } = useCompanyContext();
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [form, setForm] = useState({ name: "", repositoryPath: "", worktreeRoot: "", repository: "", baseBranch: "main", targetBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: "", allowedProfileIds: "", leadProfile: "", developerProfile: "", reviewerProfile: "" });
  const [findings, setFindings] = useState<Array<{ field: string; message: string }>>([]);
  const [error, setError] = useState("");
  const requestToken = useRef(0);
  const companyId = currentCompany?.id ?? "";

  const reload = useCallback(async (): Promise<void> => {
    const token = ++requestToken.current;
    setProjects([]);
    setProfiles([]);
    setError("");
    if (!companyId || loading) return;
    try {
      const [profileResult, projectResult] = await Promise.all([
        readJson<{ profiles: ApiProfile[] }>("/api/profiles"),
        readJson<{ projects: ApiProject[] }>(`/api/companies/${encodeURIComponent(companyId)}/projects`),
      ]);
      if (token !== requestToken.current) return;
      setProfiles(profileResult.profiles); setProjects(projectResult.projects);
    } catch (reason) {
      if (reason instanceof Error && reason.message === "Authentication required") window.location.assign("/auth");
      else setError("Unable to load projects");
    }
  }, [companyId, loading]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    setForm({ name: "", repositoryPath: "", worktreeRoot: "", repository: "", baseBranch: "main", targetBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: "", allowedProfileIds: "", leadProfile: "", developerProfile: "", reviewerProfile: "" });
    setFindings([]);
  }, [companyId]);

  const setField = (key: keyof typeof form, value: string): void => setForm((current) => ({ ...current, [key]: value }));
  const createProject = async (): Promise<void> => {
    if (!companyId || currentCompany?.status !== "active") return;
    setError(""); setFindings([]);
    try {
      await readJson<ApiProject>(`/api/companies/${companyId}/projects`, {
        method: "POST",
        body: JSON.stringify({
          ...form,
          requiredChecks: form.requiredChecks.split(",").map((value) => value.trim()).filter(Boolean),
          allowedProfileIds: form.allowedProfileIds.split(",").map((value) => value.trim()).filter(Boolean),
          roleDefaults: { lead: form.leadProfile, developer: form.developerProfile, reviewer: form.reviewerProfile },
        }),
      });
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Project configuration failed");
      if (reason instanceof Error && "findings" in reason) setFindings((reason as Error & { findings?: Array<{ field: string; message: string }> }).findings ?? []);
    }
  };
  const changeStatus = async (projectId: string, status: "activate" | "pause" | "archive"): Promise<void> => {
    setError(""); setFindings([]);
    try { await readJson(`/api/projects/${projectId}/${status}`, { method: "POST", body: "{}" }); await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Project update failed"); if (reason instanceof Error && "findings" in reason) setFindings((reason as Error & { findings?: Array<{ field: string; message: string }> }).findings ?? []); }
  };
  return (
    <ApplicationFrame title="Projects">
      <div className="bg-background text-foreground">
        <div className="grid gap-px border-b border-border/70 bg-border lg:grid-cols-[minmax(260px,360px)_1fr]">
          <section className="bg-background p-4"><div className="mb-3 flex items-center justify-between"><span className="text-xs font-semibold">New project</span><span className="text-[11px] text-muted-foreground">Draft first</span></div>
            {currentCompany ? <div className="mb-3 flex items-center gap-2 border-b border-border/70 pb-2 text-xs"><span className="font-medium truncate">{currentCompany.name}</span><span className="text-[11px] text-muted-foreground">{currentCompany.status}</span></div> : null}
            {currentCompany?.status === "active" ? <><div className="grid gap-2">{(["name", "repositoryPath", "worktreeRoot", "repository", "baseBranch", "targetBranch", "setupCommand", "verificationCommand", "requiredChecks", "allowedProfileIds", "leadProfile", "developerProfile", "reviewerProfile"] as const).map((field) => <Input key={field} aria-label={field} placeholder={field} value={form[field]} onChange={(event) => setField(field, event.target.value)} />)}</div><Button className="mt-3 w-full" onClick={() => void createProject()} disabled={!companyId}>Create draft</Button></> : currentCompany ? <p className="text-xs text-muted-foreground">{currentCompany.status === "paused" ? "Company paused. New projects are unavailable." : "Company archived. New projects are unavailable."}</p> : <p className="text-xs text-muted-foreground">{loading ? "Loading companies" : companyError ? "Unable to load companies" : user?.role === "admin" ? "Create a company to begin." : "No company access. Ask an administrator to assign a company."}</p>}
            {error ? <p role="alert" className="mt-3 text-xs text-rose-700">{error}</p> : null}
            {findings.length ? <ul className="mt-3 space-y-1 text-xs text-rose-700">{findings.map((item, index) => <li key={`${item.field}-${index}`}>{item.field}: {item.message}</li>)}</ul> : null}
          </section>
          <section className="bg-background p-4"><div className="mb-3 flex items-center justify-between"><span className="text-xs font-semibold">Configured projects</span><span className="text-[11px] text-muted-foreground">Profiles: {profiles.length}</span></div><div className="divide-y divide-border/70 border-y border-border/70">{projects.map((project) => <article className="py-3" key={project.id}><div className="flex flex-wrap items-center justify-between gap-2"><div><span className="text-[13px] font-medium">{project.name}</span><span className="ml-2 text-[11px] text-muted-foreground">{project.status} · revision {project.configurationRevision}</span></div><div className="flex gap-1.5">{project.status === "draft" ? <Button size="sm" onClick={() => void changeStatus(project.id, "activate")}>Activate</Button> : null}{project.status === "active" ? <Button variant="ghost" size="sm" onClick={() => void changeStatus(project.id, "pause")}>Pause</Button> : null}{project.status !== "archived" && project.status !== "draft" ? <Button variant="ghost" size="sm" onClick={() => void changeStatus(project.id, "archive")}>Archive</Button> : null}<a className="flex h-7 items-center px-2 text-xs text-muted-foreground hover:text-foreground" href={`/api/projects/${project.id}`}>Inspect</a></div></div><div className="mt-2 grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2"><span className="truncate">{project.repositoryPath}</span><span className="truncate">{project.repository ?? "Repository not verified"}</span><span>Base {project.baseBranch}</span><span>Target {project.targetBranch}</span></div></article>)}{!loading && currentCompany && projects.length === 0 ? <div className="py-8 text-center text-xs text-muted-foreground">No projects configured.</div> : null}</div></section>
        </div>
      </div>
    </ApplicationFrame>
  );
}

async function fileAsImage(file: File): Promise<{ filename: string; mimeType: string; base64: string }> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Unable to read image"));
    reader.onload = () => resolve({ filename: file.name, mimeType: file.type, base64: String(reader.result).replace(/^data:[^;]+;base64,/, "") });
    reader.readAsDataURL(file);
  });
}

function TasksView(): ReactElement {
  const { currentCompany, loading, user, error: companyError } = useCompanyContext();
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [tasks, setTasks] = useState<ApiTask[]>([]);
  const [selected, setSelected] = useState<ApiTask>();
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [images, setImages] = useState<Array<{ filename: string; mimeType: string; base64: string }>>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [detailNotFound, setDetailNotFound] = useState(false);
  const selectedRef = useRef<ApiTask | undefined>(undefined);
  const requestToken = useRef(0);
  const companyId = currentCompany?.id ?? "";

  useEffect(() => { selectedRef.current = selected; }, [selected]);

  const reload = useCallback(async (): Promise<void> => {
    const token = ++requestToken.current;
    setProjects([]); setTasks([]); setError("");
    if (!companyId || loading) return;
    try {
      const [projectResult, taskResult] = await Promise.all([
        readJson<{ projects: ApiProject[] }>(`/api/companies/${encodeURIComponent(companyId)}/projects`),
        readJson<{ tasks: ApiTask[] }>(`/api/companies/${encodeURIComponent(companyId)}/tasks`),
      ]);
      if (token !== requestToken.current) return;
      setProjects(projectResult.projects); setTasks(taskResult.tasks);
      setProjectId((current) => projectResult.projects.some((project) => project.id === current && project.status === "active") ? current : projectResult.projects.find((project) => project.status === "active")?.id ?? "");
      const routeTaskId = window.location.pathname.startsWith("/tasks/") ? decodeURIComponent(window.location.pathname.slice("/tasks/".length)) : "";
      const nextSelected = routeTaskId ? taskResult.tasks.find((task) => task.id === routeTaskId) : selectedRef.current ? taskResult.tasks.find((task) => task.id === selectedRef.current!.id) : undefined;
      setSelected(nextSelected);
      setDetailNotFound(Boolean(routeTaskId) && !nextSelected);
    } catch (reason) {
      if (reason instanceof Error && reason.message === "Authentication required") window.location.assign("/auth");
      else setError("Unable to load tasks");
    }
  }, [companyId, loading]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    selectedRef.current = undefined;
    setSelected(undefined); setProjectId(""); setTitle(""); setDescription(""); setImages([]); setDetailNotFound(false);
  }, [companyId]);
  useEffect(() => {
    const events = new EventSource("/api/tasks/events");
    events.addEventListener("invalidate", () => void reload());
    return () => events.close();
  }, [reload]);

  const availableProjects = projects.filter((project) => project.companyId === companyId && project.status === "active");
  const selectTask = (task: ApiTask): void => { setSelected(task); selectedRef.current = task; setDetailNotFound(false); window.history.pushState({}, "", withCompany(`/tasks/${encodeURIComponent(task.id)}`, companyId)); };
  const create = async (): Promise<void> => {
    if (!companyId || currentCompany?.status !== "active") return;
    setBusy(true); setError("");
    try {
      const result = await readJson<ApiTask>(`/api/companies/${companyId}/tasks`, { method: "POST", body: JSON.stringify({ projectId, title, description, images, idempotencyKey: crypto.randomUUID() }) });
      setTitle(""); setDescription(""); setImages([]); selectedRef.current = result; setSelected(result); await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to create task"); }
    finally { setBusy(false); }
  };
  const startPlanning = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true); setError("");
    try { const updated = await readJson<ApiTask>(`/api/tasks/${selected.id}/start-planning`, { method: "POST", body: JSON.stringify({ expectedRevision: selected.revision }) }); selectedRef.current = updated; setSelected(updated); await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to start planning"); }
    finally { setBusy(false); }
  };
  const planAction = async (path: "request-supplemental-review" | "approve-plan" | "reject-plan" | "start-development" | "retry-development" | "cancel-development" | "review-delivery" | "repair-delivery" | "record-delivery-decision", note?: string): Promise<void> => {
    if (!selected) return;
    setBusy(true); setError("");
    try { const updated = await readJson<ApiTask>(`/api/tasks/${selected.id}/${path}`, { method: "POST", body: JSON.stringify({ expectedRevision: selected.revision, ...(note ? { note } : {}) }) }); selectedRef.current = updated; setSelected(updated); await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to update the plan"); }
    finally { setBusy(false); }
  };

  return (
    <ApplicationFrame title="Tasks">
      <div className="bg-background text-foreground">
        <div className="grid gap-px border-b border-border/70 bg-border lg:grid-cols-[minmax(280px,360px)_1fr]">
          <section className="bg-background p-4"><div className="mb-3 flex items-center justify-between"><span className="text-xs font-semibold">New task</span><span className="text-[11px] text-muted-foreground">Backlog first</span></div>
            {currentCompany ? <div className="mb-3 flex items-center gap-2 border-b border-border/70 pb-2 text-xs"><span className="font-medium truncate">{currentCompany.name}</span><span className="text-[11px] text-muted-foreground">{currentCompany.status}</span></div> : null}
            {currentCompany?.status === "active" ? <><label className="mb-1 block text-[11px] text-muted-foreground" htmlFor="task-project">Project</label><select id="task-project" className="mb-2 h-7 w-full border border-input bg-background px-2 text-xs" value={projectId} onChange={(event) => setProjectId(event.target.value)}>{availableProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
            <div className="grid gap-2"><Input aria-label="Task title" placeholder="Title" value={title} onChange={(event) => setTitle(event.target.value)} /><textarea aria-label="Task description" className="min-h-32 border border-input bg-background px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring" placeholder="Markdown description" value={description} onChange={(event) => setDescription(event.target.value)} /><input aria-label="Task images" className="text-xs" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => void Promise.all(Array.from(event.target.files ?? []).map(fileAsImage)).then(setImages).catch(() => setError("Unable to read image"))} /></div></> : currentCompany ? <p className="text-xs text-muted-foreground">{currentCompany.status === "paused" ? "Company paused. New tasks are unavailable." : "Company archived. New tasks are unavailable."}</p> : <p className="text-xs text-muted-foreground">{loading ? "Loading companies" : companyError ? "Unable to load companies" : user?.role === "admin" ? "Create a company to begin." : "No company access. Ask an administrator to assign a company."}</p>}
            {images.length ? <div className="mt-2 text-[11px] text-muted-foreground">{images.map((image) => <div key={image.filename}>{image.filename}</div>)}</div> : null}
            {currentCompany?.status === "active" ? <Button className="mt-3 w-full" onClick={() => void create()} disabled={busy || !companyId || !projectId || !title.trim() || !description.trim()}>{busy ? "Saving…" : "Create task"}</Button> : null}
            {error ? <p role="alert" className="mt-3 text-xs text-rose-700">{error}</p> : null}
          </section>
          <section className="bg-background p-4"><div className="mb-3 flex items-center justify-between"><span className="text-xs font-semibold">Board</span><span className="text-[11px] text-muted-foreground">Read-only state</span></div><div className="grid gap-3 md:grid-cols-4 xl:grid-cols-7">{(["backlog", "planning", "approval", "ready_for_development", "development", "delivery_ready", "reviewing_delivery", "repair_required", "delivery_reviewed", "delivery_blocked"] as const).map((phase) => <div className="border border-border/70" key={phase}><div className="flex h-8 items-center justify-between border-b border-border/70 px-3 text-[11px] font-semibold text-muted-foreground"><span>{phase === "ready_for_development" ? "Ready" : phase === "delivery_ready" ? "Delivered" : phase === "reviewing_delivery" ? "Reviewing" : phase === "repair_required" ? "Repair" : phase === "delivery_reviewed" ? "Reviewed" : phase === "delivery_blocked" ? "Blocked" : phase[0]!.toUpperCase() + phase.slice(1)}</span><span>{tasks.filter((task) => task.phase === phase).length}</span></div><div className="divide-y divide-border/70">{tasks.filter((task) => task.phase === phase).map((task) => <button className="block w-full px-3 py-3 text-left text-xs hover:bg-muted/40" key={task.id} onClick={() => selectTask(task)}><span className="block font-medium">{task.title}</span><span className="mt-1 block text-[11px] text-muted-foreground">{task.pendingAction}</span></button>)}</div></div>)}</div>
            {detailNotFound ? <div className="mt-4 border border-border/70 p-4 text-xs text-muted-foreground">Task not found for this company.</div> : null}
            {selected ? <article className="mt-4 border border-border/70"><div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-3 py-2"><div><span className="text-[13px] font-semibold">{selected.title}</span><span className="ml-2 text-[11px] text-muted-foreground">{selected.phase} · revision {selected.revision}</span></div><div className="flex flex-wrap gap-2">{selected.allowedCommands.includes("start_planning") ? <Button size="sm" onClick={() => void startPlanning()} disabled={busy}>{busy ? "Planning…" : "Start planning"}</Button> : null}{selected.allowedCommands.includes("request_supplemental_review") ? <Button size="sm" variant="outline" onClick={() => void planAction("request-supplemental-review")} disabled={busy}>Request review</Button> : null}{selected.allowedCommands.includes("approve_plan") ? <Button size="sm" onClick={() => void planAction("approve-plan", "Approved final plan")} disabled={busy}>Approve plan</Button> : null}{selected.allowedCommands.includes("reject_plan") ? <Button size="sm" variant="outline" onClick={() => void planAction("reject-plan", "Please revise the plan")} disabled={busy}>Request changes</Button> : null}{selected.allowedCommands.includes("start_development") ? <Button size="sm" onClick={() => void planAction("start-development")} disabled={busy}>{busy ? "Executing…" : "Start development"}</Button> : null}{selected.allowedCommands.includes("retry_development") ? <Button size="sm" onClick={() => void planAction("retry-development")} disabled={busy}>{busy ? "Retrying…" : "Retry development"}</Button> : null}{selected.allowedCommands.includes("cancel_development") ? <Button size="sm" variant="outline" onClick={() => void planAction("cancel-development")} disabled={busy}>Cancel development</Button> : null}{selected.allowedCommands.includes("review_delivery") ? <Button size="sm" onClick={() => void planAction("review-delivery")} disabled={busy}>{busy ? "Reviewing…" : "Review delivery"}</Button> : null}{selected.allowedCommands.includes("repair_delivery") ? <Button size="sm" onClick={() => void planAction("repair-delivery")} disabled={busy}>{busy ? "Repairing…" : "Repair delivery"}</Button> : null}{selected.allowedCommands.includes("record_delivery_decision") ? <Button size="sm" variant="outline" onClick={() => void planAction("record-delivery-decision", "Member decision recorded")} disabled={busy}>Record decision</Button> : null}</div></div><div className="grid gap-4 p-3 text-xs sm:grid-cols-[minmax(0,1fr)_220px]"><div className="min-w-0"><pre className="whitespace-pre-wrap font-sans leading-5">{selected.description}</pre>{selected.images.length ? <div className="mt-4 flex flex-wrap gap-2">{selected.images.map((image) => <a className="border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground" key={image.artifactId} href={`/api/tasks/${selected.id}/images/${image.artifactId}`} target="_blank" rel="noreferrer">{image.filename}</a>)}</div> : null}{selected.leadOutput ? <div className="mt-4 border-t border-border/70 pt-3"><div className="mb-2 flex items-center justify-between"><span className="text-xs font-semibold">{selected.leadOutput.kind === "plan" ? "Lead plan" : "Decision blocker"}</span><span className="text-[11px] text-muted-foreground">{selected.leadOutput.summary}</span></div>{selected.leadOutput.content.kind === "plan" ? <><p className="mb-2 whitespace-pre-wrap">{selected.leadOutput.content.compatibilityAnalysis}</p><ol className="list-decimal space-y-2 pl-5">{selected.leadOutput.content.steps.map((step) => <li key={step.number}><div>{step.instruction}</div><div className="text-[11px] text-muted-foreground">Verify: {step.verification}</div></li>)}</ol><p className="mt-3 whitespace-pre-wrap">{selected.leadOutput.content.verificationStrategy}</p></> : <div className="space-y-2"><p className="whitespace-pre-wrap">{selected.leadOutput.content.evidence}</p><div><span className="font-medium">Question: </span>{selected.leadOutput.content.question}</div><div><span className="font-medium">Next: </span>{selected.leadOutput.content.nextAction}</div></div>}</div> : null}{selected.developerExecution ? <div className="mt-4 border-t border-border/70 pt-3"><div className="mb-2 flex items-center justify-between"><span className="text-xs font-semibold">Developer delivery</span><span className="text-[11px] text-muted-foreground">{selected.developerExecution.status}</span></div><div>{selected.developerExecution.deliverySummary ?? selected.pendingAction}</div><div className="mt-2 text-[11px] text-muted-foreground">{selected.developerExecution.branchName} · {selected.developerExecution.resultCommit ?? "no commit yet"}</div></div> : null}{selected.deliveryReview ? <div className="mt-4 border-t border-border/70 pt-3"><div className="mb-2 flex items-center justify-between"><span className="text-xs font-semibold">Delivery review</span><span className="text-[11px] text-muted-foreground">{selected.deliveryReview.outcome}</span></div><div>{selected.deliveryReview.summary}</div><div className="mt-2 space-y-2">{selected.deliveryReview.findings.map((finding) => <div className="border-l-2 border-border pl-2" key={finding.id}><div className="font-medium">{finding.severity} · {finding.disposition}</div><div className="text-[11px] text-muted-foreground">{finding.rationale}</div></div>)}</div></div> : null}</div><div className="border-l border-border/70 pl-3"><div className="mb-2 text-[11px] text-muted-foreground">Owner</div><div>{selected.owner}</div><div className="mb-2 mt-3 text-[11px] text-muted-foreground">Next action</div><div>{selected.pendingAction ?? "None"}</div><div className="mb-2 mt-3 text-[11px] text-muted-foreground">Timeline</div><div className="space-y-2">{selected.timeline.map((entry) => <div key={entry.id}><div>{entry.eventType}</div><div className="text-[11px] text-muted-foreground">revision {entry.revision}</div></div>)}</div></div></div></article> : null}
          </section>
        </div>
      </div>
    </ApplicationFrame>
  );
}

function AttentionView(): ReactElement {
  const [companies, setCompanies] = useState<ApiAttentionCompany[]>([]);
  const [error, setError] = useState("");
  const reload = useCallback(async (): Promise<void> => {
    try { setCompanies((await readJson<{ companies: ApiAttentionCompany[] }>("/api/attention")).companies); }
    catch (reason) { if (reason instanceof Error && reason.message === "Authentication required") window.location.assign("/auth"); else setError("Unable to load attention"); }
  }, []);
  useEffect(() => { void reload(); const timer = window.setInterval(() => void reload(), 15_000); return () => window.clearInterval(timer); }, [reload]);
  return (
    <ApplicationFrame title="Attention">
      <div className="divide-y divide-border/70">
        <div className="flex h-9 items-center justify-between border-b border-border/70 px-3 text-xs sm:px-4"><span className="font-medium">Agency attention</span><button className="text-muted-foreground hover:text-foreground" onClick={() => void reload()}>Refresh</button></div>
        {companies.map((company) => <section className="bg-background p-3 sm:p-4" key={company.companyId}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 pb-2"><div className="flex items-center gap-2 text-[13px] font-medium"><span className={company.attentionCount ? "size-1.5 rounded-full bg-amber-500" : "size-1.5 rounded-full bg-emerald-500"} />{company.companyName}</div><div className="text-[11px] text-muted-foreground">{company.activeIssueCount} active · {company.attentionCount} needs a person</div></div>
          <div className="divide-y divide-border/70">{company.attention.map((item) => <details className="group py-3" key={item.id}><summary className="flex cursor-pointer list-none items-start justify-between gap-3 text-xs"><span className="min-w-0"><span className="mr-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">{item.category.replaceAll("_", " ")}</span><span className="font-medium">{item.taskTitle}</span><span className="mt-1 block text-muted-foreground">{item.summary}</span></span><span className="shrink-0 text-[11px] text-muted-foreground group-open:rotate-90">›</span></summary><div className="mt-2 grid gap-2 border-l-2 border-amber-300 pl-3 text-[11px] text-muted-foreground sm:grid-cols-[1fr_auto] sm:items-center"><span>{item.action}{item.evidenceRef ? ` · Evidence ${item.evidenceRef}` : ""}</span><a className="text-foreground underline underline-offset-2" href={withCompany(`/tasks/${encodeURIComponent(item.taskId)}`, item.companyId)}>Open issue</a></div></details>)}</div>
          {company.attention.length === 0 ? <div className="py-5 text-center text-xs text-muted-foreground">No decision needed.</div> : null}
          {company.recentOutcomes.length ? <div className="mt-3 border-t border-border/70 pt-2 text-[11px] text-muted-foreground">Recent: {company.recentOutcomes.map((outcome) => `${outcome.taskTitle} · ${outcome.phase}`).join(" · ")}</div> : null}
        </section>)}
        {companies.length === 0 && !error ? <div className="p-8 text-center text-xs text-muted-foreground">No companies visible.</div> : null}
        {error ? <p role="alert" className="px-4 py-3 text-xs text-rose-700">{error}</p> : null}
      </div>
    </ApplicationFrame>
  );
}

function CompanySettingsView(): ReactElement {
  const { user, companies, currentCompany, loading, selectCompany, renameCompany, setCompanyStatus } = useCompanyContext();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const pathId = useMemo(() => {
    const match = /^\/companies\/([^/]+)\/settings$/.exec(window.location.pathname);
    if (!match?.[1]) return "";
    try { return decodeURIComponent(match[1]); } catch { return ""; }
  }, []);
  const company = companies.find((candidate) => candidate.id === pathId);

  useEffect(() => {
    if (company && company.id !== currentCompany?.id) selectCompany(company.id);
  }, [company, currentCompany?.id, selectCompany]);
  useEffect(() => { setName(company?.name ?? ""); setSaved(false); }, [company?.id]);

  const notFound = !loading && (user?.role !== "admin" || !company);
  if (loading) {
    return <ApplicationFrame title="Company settings"><div className="p-4 text-xs text-muted-foreground">Loading company settings…</div></ApplicationFrame>;
  }
  if (notFound) {
    return <ApplicationFrame title="Company settings"><div className="p-4"><p className="text-xs text-muted-foreground">Company not found.</p><a className="mt-3 inline-flex text-xs text-primary underline underline-offset-2" href={withCompany("/projects", currentCompany?.id)}>Back to Projects</a></div></ApplicationFrame>;
  }
  if (!company) return <ApplicationFrame title="Company settings"><div className="p-4 text-xs text-muted-foreground">Company not found.</div></ApplicationFrame>;

  const mutateStatus = async (status: CompanyStatus): Promise<void> => {
    setBusy(status); setError("");
    try { await setCompanyStatus(company.id, status); setArchiveOpen(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to update company"); }
    finally { setBusy(""); }
  };
  const save = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === company.name || busy) return;
    setBusy("rename"); setError(""); setSaved(false);
    try { await renameCompany(company.id, trimmed); setSaved(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to rename company"); }
    finally { setBusy(""); }
  };

  return (
    <ApplicationFrame title="Company settings">
      <div className="max-w-3xl divide-y divide-border/70">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-3 py-3 sm:px-4"><div><div className="text-[13px] font-semibold">{company.name}</div><div className="mt-1 text-[11px] text-muted-foreground">Company settings · {company.status}</div></div><span className="text-[11px] text-muted-foreground">{company.id}</span></div>
        <section className="p-3 sm:p-4">
          <div className="border border-border/70">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-3 py-2"><span className="text-xs font-semibold">Details</span><span className="text-[11px] text-muted-foreground">Created {new Date(company.createdAt).toLocaleDateString()}</span></div>
            <div className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"><div><label className="mb-1 block text-[11px] text-muted-foreground" htmlFor="company-name">Company name</label><Input id="company-name" value={name} onChange={(event) => { setName(event.target.value); setSaved(false); }} /></div><Button size="sm" onClick={() => void save()} disabled={busy !== "" || !name.trim() || name.trim() === company.name}><Save className="size-3.5" />{busy === "rename" ? "Saving…" : saved ? "Saved" : "Save"}</Button></div>
            {error ? <p role="alert" className="px-3 pb-3 text-xs text-rose-700">{error}</p> : null}
            <div className="grid gap-2 border-t border-border/70 px-3 py-3 text-xs sm:grid-cols-[max-content_1fr]"><span className="text-[11px] text-muted-foreground">Status</span><span>{company.status}</span><span className="text-[11px] text-muted-foreground">Company ID</span><code className="select-all text-[11px] text-muted-foreground">{company.id}</code></div>
          </div>
        </section>
        <section className="p-3 sm:p-4"><div className="mb-2 text-xs font-semibold">Lifecycle</div><div className="divide-y divide-border/70 border border-border/70 text-xs">
          {company.status === "active" ? <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3"><div><div className="font-medium">Pause company</div><div className="mt-1 text-[11px] text-muted-foreground">Existing records remain available; new projects and tasks are blocked.</div></div><Button variant="outline" size="sm" onClick={() => void mutateStatus("paused")} disabled={busy !== ""}><Pause className="size-3.5" />{busy === "paused" ? "Pausing…" : "Pause company"}</Button></div> : null}
          {company.status === "paused" ? <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3"><div><div className="font-medium">Reactivate company</div><div className="mt-1 text-[11px] text-muted-foreground">Restore creation of new projects and tasks.</div></div><Button size="sm" onClick={() => void mutateStatus("active")} disabled={busy !== ""}><RotateCcw className="size-3.5" />{busy === "active" ? "Reactivating…" : "Reactivate company"}</Button></div> : null}
          {company.status !== "archived" ? <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3"><div><div className="font-medium text-rose-700">Archive company</div><div className="mt-1 text-[11px] text-muted-foreground">Archive is reversible, retains history, and blocks new work.</div></div><Button variant="outline" size="sm" className="text-rose-700" onClick={() => setArchiveOpen(true)} disabled={busy !== ""}><Archive className="size-3.5" />Archive company</Button></div> : null}
          {company.status === "archived" ? <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3"><div><div className="font-medium">Restore company</div><div className="mt-1 text-[11px] text-muted-foreground">Restore the company to active status.</div></div><Button size="sm" onClick={() => void mutateStatus("active")} disabled={busy !== ""}><RotateCcw className="size-3.5" />{busy === "active" ? "Restoring…" : "Restore company"}</Button></div> : null}
        </div></section>
      </div>
      <Dialog.Root open={archiveOpen} onOpenChange={setArchiveOpen}><Dialog.Portal><Dialog.Backdrop className="fixed inset-0 z-50 bg-black/20" /><Dialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,380px)] -translate-x-1/2 -translate-y-1/2 border border-border bg-background p-4 shadow-lg outline-none"><Dialog.Title className="text-[13px] font-semibold">Archive {company.name}?</Dialog.Title><Dialog.Description className="mt-2 text-xs text-muted-foreground">This is reversible. Project and task history remains readable, but new work is blocked.</Dialog.Description><div className="mt-4 flex justify-end gap-2"><Dialog.Close render={<Button variant="ghost" size="sm">Cancel</Button>} /><Button variant="outline" size="sm" className="text-rose-700" onClick={() => void mutateStatus("archived")} disabled={busy !== ""}>{busy === "archived" ? "Archiving…" : "Archive"}</Button></div></Dialog.Popup></Dialog.Portal></Dialog.Root>
    </ApplicationFrame>
  );
}

function StatusIndicator({ status }: { status: HealthCheck["status"] }): ReactElement {
  const healthy = status === "healthy";
  return (
    <span className={healthy ? "flex items-center gap-1.5 text-xs text-emerald-700" : "flex items-center gap-1.5 text-xs text-rose-700"}>
      <span className={healthy ? "size-1.5 rounded-full bg-emerald-500" : "size-1.5 rounded-full bg-rose-500"} />
      {healthy ? "Healthy" : "Unhealthy"}
    </span>
  );
}

function HealthRow({ check }: { check: HealthCheck }): ReactElement {
  const Icon = icons[check.id] ?? CircleHelp;
  return (
    <Collapsible.Root data-slot="health-row" data-status={check.status} className="group border-b border-border/70 last:border-b-0">
      <Collapsible.Trigger className="flex min-h-9 w-full items-center gap-2.5 px-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring/50 sm:px-4">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{check.label}</span>
        <span className="hidden min-w-0 flex-1 truncate pl-2 text-xs text-muted-foreground sm:block">{check.summary}</span>
        <StatusIndicator status={check.status} />
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="border-t border-border/70 bg-muted/20 px-9 py-2.5 sm:px-11">
        {Object.keys(check.details).length > 0 ? (
          <dl className="grid gap-1.5 text-xs sm:grid-cols-[max-content_1fr] sm:gap-x-5">
            {Object.entries(check.details).map(([key, value]) => (
              <div className="contents" key={key}>
                <dt className="text-muted-foreground">{key}</dt>
                <dd className="truncate text-foreground/80">{String(value)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <span className="text-xs text-muted-foreground">No additional details reported.</span>
        )}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function Dashboard({ initialSnapshot }: { initialSnapshot: HealthSnapshot }): ReactElement {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/health", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("Health request failed");
      setSnapshot(await response.json() as HealthSnapshot);
    } catch {
      // Keep the last truthful snapshot visible when a refresh is interrupted.
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const ownedChecks = useMemo(() => snapshot.checks.filter((check) => isOwnedHealthCheck(check.id)), [snapshot.checks]);
  const providerChecks = useMemo(() => snapshot.checks.filter((check) => !isOwnedHealthCheck(check.id)), [snapshot.checks]);
  const healthyCount = snapshot.checks.filter((check) => check.status === "healthy").length;
  const failingCount = snapshot.checks.length - healthyCount;

  return (
    <ApplicationFrame title="Host health" headerRight={
      <div className="flex items-center gap-2">
        <span className={snapshot.ready ? "hidden items-center gap-1.5 text-xs text-emerald-700 sm:flex" : "hidden items-center gap-1.5 text-xs text-amber-700 sm:flex"}>
          <span className={snapshot.ready ? "size-1.5 rounded-full bg-emerald-500" : "size-1.5 rounded-full bg-amber-500"} />
          {snapshot.ready ? "Ready" : "Needs attention"}
        </span>
        <a className="max-w-[34vw] truncate text-[11px] text-muted-foreground hover:text-foreground sm:max-w-64 sm:text-xs" href={snapshot.reachableAddress}>{snapshot.reachableAddress.replace(/^https?:\/\//, "")}</a>
        <span className="hidden text-xs text-muted-foreground md:inline">{relativeTime(snapshot.generatedAt)}</span>
        <Button aria-label="Refresh health" title="Refresh health" variant="ghost" size="icon" onClick={() => void refresh()} disabled={refreshing}><RefreshCw className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} /></Button>
      </div>
    }>

          <div className="flex h-9 items-center justify-between border-b border-border/70 bg-muted/20 px-3 sm:px-4">
            <div className="flex h-full items-center gap-4 text-xs">
              <span className="flex h-full items-center border-b-2 border-primary font-medium text-foreground">Health</span>
              <span className="text-muted-foreground">{snapshot.checks.length} checks</span>
              <span className="text-emerald-700">{healthyCount} healthy</span>
              <span className={failingCount > 0 ? "text-rose-700" : "text-muted-foreground"}>{failingCount} issues</span>
            </div>
            <span className="hidden items-center gap-1.5 text-[11px] text-muted-foreground sm:flex"><Clock3 className="size-3" />Updated {relativeTime(snapshot.generatedAt)}</span>
          </div>

          <div>
            <section aria-labelledby="owned-services">
              <div className="flex h-8 items-center justify-between border-b border-border/70 px-3 sm:px-4">
                <h2 id="owned-services" className="text-[11px] font-semibold text-muted-foreground">Owned services</h2>
                <span className="text-[11px] text-muted-foreground">{ownedChecks.length}</span>
              </div>
              <div>{ownedChecks.map((check) => <HealthRow check={check} key={check.id} />)}</div>
            </section>
            <section aria-labelledby="provider-access" className="mt-5">
              <div className="flex h-8 items-center justify-between border-y border-border/70 px-3 sm:px-4">
                <h2 id="provider-access" className="text-[11px] font-semibold text-muted-foreground">Provider access</h2>
                <span className="text-[11px] text-muted-foreground">{providerChecks.length}</span>
              </div>
              <div>{providerChecks.map((check) => <HealthRow check={check} key={check.id} />)}</div>
            </section>
          </div>

    </ApplicationFrame>
  );
}

const view = window.__FORGE_VIEW__;
const authenticatedView = view === "admin" ? <AdminView /> : view === "projects" ? <ProjectsView /> : view === "tasks" ? <TasksView /> : view === "attention" ? <AttentionView /> : view === "company-settings" ? <CompanySettingsView /> : <Dashboard initialSnapshot={window.__FORGE_HEALTH__} />;
createRoot(document.getElementById("forge-app")!).render(view === "auth" ? <AuthView /> : <CompanyProvider>{authenticatedView}</CompanyProvider>);
