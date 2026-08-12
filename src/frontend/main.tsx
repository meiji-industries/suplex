import { Collapsible } from "./components/ui/collapsible.js";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./components/ui/accordion.js";
import { Alert, AlertDescription } from "./components/ui/alert.js";
import { Button } from "./components/ui/button.js";
import { Badge } from "./components/ui/badge.js";
import { Checkbox } from "./components/ui/checkbox.js";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "./components/ui/field.js";
import { Input } from "./components/ui/input.js";
import { InlineAttachmentPicker } from "./components/ui/inline-attachment-picker.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.js";
import { Textarea } from "./components/ui/textarea.js";
import { Skeleton } from "./components/ui/skeleton.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./components/ui/alert-dialog.js";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu.js";
import { CreateButton } from "./components/ui/create-button.js";
import { Kanban, KanbanBoard, KanbanColumn, KanbanColumnContent } from "./components/reui/kanban.js";
import { Badge as ReuiBadge } from "./components/reui/badge.js";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs.js";
import { ApplicationFrame } from "./components/app/application-frame.js";
import { CompanyProvider, useCompanyContext } from "./components/app/company-context.js";
import { SettingsLayout, SettingsSection, SettingRow } from "./components/app/settings-layout.js";
import { TaskHistory } from "./components/app/task-history.js";
import { TaskLeadPlan } from "./components/app/task-lead-plan.js";
import { TaskProgress } from "./components/app/task-progress.js";
import { companySettingsPath, isApiError, readJson, withCompany, type ApiUser, type CompanyStatus } from "./lib/api.js";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { HealthCheck, HealthSnapshot } from "../health.js";
import { isOwnedHealthCheck } from "../health-contract.js";
import { releaseFailureCopy, type ReleaseFailureCode } from "../release-failures.js";
import {
  Activity,
  Archive,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  CircleDashed,
  CircleDotDashed,
  CircleX,
  Clock3,
  Database,
  Ellipsis,
  Filter,
  GitBranch,
  HardDrive,
  Layers3,
  ListFilter,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Terminal,
  Pause,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";
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
type ApiModel = { id: string; displayName: string; description: string; status: "active" | "retired"; sortOrder: number };
type ApiCheck = { name: string; status: string; conclusion?: string };
type ApiInvitation = { id: string; kind: "bootstrap" | "user" | "recovery"; displayName: string; expiresAt: string; status: "active" | "expired" | "consumed" | "replaced"; createdAt: string };
type ApiCredential = { id: string; userId: string; credentialId: string; createdAt: string; revokedAt?: string };
type ApiProject = { id: string; companyId: string; name: string; repositoryPath: string; worktreeRoot: string; repository?: string; baseBranch: string; targetBranch: string; setupCommand: string; verificationCommand: string; requiredChecks: string[]; allowedProfileIds: string[]; roleDefaults: Record<string, string>; status: "draft" | "active" | "paused" | "needs-reactivation" | "archived"; configurationRevision: number; configurationIdentity?: string; baseSha?: string; targetSha?: string };

type ApiAttentionItem = { id: string; companyId: string; taskId: string; taskTitle: string; category: string; summary: string; action: string; evidenceRef?: string; updatedAt: string };
type ApiAttentionCompany = { companyId: string; companyName: string; companyStatus: string; activeIssueCount: number; phases: Record<string, number>; attentionCount: number; attention: ApiAttentionItem[]; recentOutcomes: Array<{ taskId: string; taskTitle: string; phase: string; updatedAt: string }> };
type ApiAgentInvocation = { id: string; role: "lead" | "reviewer" | "developer"; status: string; attempt: number; sessionPresent: boolean; startedAt: string; finishedAt: string | null; failureCode: string | null; failureSummary: string | null; evidenceArtifactId: string | null };
type ApiCi = { runId: string; releaseId: string; repository: string; pullRequestNumber: number; pullRequestUrl: string; baseBranch: string; headBranch: string; expectedHeadSha: string; expectedHeadTree: string; status: string; outcome: string | null; reason: string | null; owner: string | null; repairable: boolean; policyHash: string; policy: { projectRevisionId: string; requiredChecks: string[]; acceptedConclusions: ["success"] }; leadSessionContinuity: boolean; developerSessionContinuity: boolean; firstObservedAt: string | null; propagationDeadline: string | null; overallDeadline: string | null; nextRetryAt: string | null; completedAt: string | null; supersededAt: string | null; supersededRuns: Array<{ runId: string; releaseId: string; expectedHeadSha: string; expectedHeadTree: string | null; status: string; supersededAt: string | null }>; attempts: Array<{ id: string; attemptNumber: number; observedRepository: string | null; observedPrNumber: number | null; observedBaseBranch: string | null; observedBaseSha: string | null; observedHeadBranch: string | null; observedHeadSha: string | null; outcome: string; reason: string; owner: string | null; repairable: boolean; retryAt: string | null; summary: string; evidenceArtifactId: string | null; createdAt: string; checks: Array<{ providerCheckId: string; name: string; headSha: string; status: string; conclusion: string | null; detailsUrl: string | null; summary: string | null; startedAt: string | null; completedAt: string | null; selectedForEvaluation: boolean }> }>; repairPlan: { id: string; status: string; ciRunId: string; ciAttemptId: string; failedHeadSha: string; planArtifactId: string; evidenceArtifactId: string; summary: string; steps: Array<{ number: number; instruction: string; verification: string }>; createdAt: string; updatedAt: string; consumedAt: string | null; supersededAt: string | null } | null; repairs: Array<{ id: string; repairPlanId: string; priorCommit: string; priorTree: string; newCommit: string | null; newTree: string | null; deliveryArtifactId: string | null; evidenceArtifactId: string | null; status: string; summary: string | null; createdAt: string; completedAt: string | null }> };
type ApiRelease = { id: string; status: "reconciling" | "draft" | "blocked"; failureCode: ReleaseFailureCode | null; failureSummary: string | null; retryAt: string | null; repository: string; baseBranch: string; headBranch: string; baseSha: string; headSha: string; headTree: string; reviewedCommit: { abbreviated: string; full: string }; reviewedTree: { abbreviated: string; full: string }; pullRequestNumber: number | null; pullRequestUrl: string | null; isDraft: boolean; reused: boolean; bodyArtifactId: string | null; title: string; bodyPreview: string | null; operation: { kind: string; status: string; attempt: number | null; startedAt: string | null; observedAt: string | null; completedAt: string | null } | null };
type ApiTargetBaseReconciliation = { checkId: string | null; checkpoint: string | null; status: string | null; expectedBaseSha: string | null; observedBaseSha: string | null; priorHead: string | null; priorTree: string | null; resultHead: string | null; resultTree: string | null; conflictFileCount: number | null; conflictArtifact: { id: string; sha256: string; kind: string } | null; verificationArtifact: { id: string; sha256: string; kind: string } | null; deliveryArtifact: { id: string; sha256: string; kind: string } | null; invalidatedDeliveryReviewId: string | null; invalidatedCiRunId: string | null; invalidatedFinalReviewId: string | null; invalidatedAcceptanceId: string | null; releaseId: string | null; pullRequestNumber: number | null; pullRequestUrl: string | null; blockerCode: string | null; blockerOwner: string | null; retryable: boolean | null; summary: string | null; actions: string[] };
type TaskPhase = "backlog" | "planning" | "approval" | "ready_for_development" | "development" | "delivery_ready" | "reviewing_delivery" | "repair_required" | "delivery_reviewed" | "releasing" | "merge_conflict_reviewing" | "merge_conflict_required" | "merge_conflict_resolving" | "ci_waiting" | "ci_repair_planning" | "ci_repairing" | "ci_repair_required" | "final_review" | "accepted" | "manual_merge" | "done" | "delivery_blocked" | "cancelled" | "failed";
type ApiTask = { id: string; companyId: string; projectId: string; title: string; description: string; briefArtifactId: string; images: Array<{ artifactId: string; filename: string; mimeType: string; byteSize: number }>; roleProfiles: Record<string, string>; supplementalReview: boolean; workflowId: string; projectRevisionId: string; phase: TaskPhase; revision: number; owner: "human" | "lead"; allowedCommands: string[]; pendingAction: string | null; createdAt: string; updatedAt: string; projection: { authoritativeRevision: number; projectedRevision: number; projectedAt: string; status: "current" | "lagging" }; timeline: Array<{ id: string; revision: number; eventType: string; metadata: Record<string, string | number | boolean>; createdAt: string }>; agentInvocations: ApiAgentInvocation[]; targetBaseReconciliation: ApiTargetBaseReconciliation; planRevision?: number | null; planMaterial?: boolean | null; materialCategories?: string[]; supplementalReviewUsed?: boolean; supplementalReviewArtifactId?: string | null; decisionId?: string | null; release?: ApiRelease | null; ci?: ApiCi; deliveryReview?: { id: string; outcome: "approved" | "blocking"; summary: string; planRevision: number; baseSha: string; subjectCommit: string; subjectTree: string; findings: Array<{ id: string; severity: "blocking" | "advisory"; rationale: string; evidenceRef: string; disposition: string; repairInstruction: string | null }> }; developerExecution?: { id: string; status: string; attempt: number; branchName: string; targetBaseSha: string; currentStep?: number | null; resultCommit?: string | null; resultTree?: string | null; dirtyState?: string | null; deliveryArtifactId?: string | null; evidenceArtifactId?: string | null; failureCode?: string | null; failureSummary?: string | null; deliverySummary?: string | null }; leadOutput?: { kind: "plan" | "decision_blocker"; summary: string; executionId: string; outputArtifactId: string; evidenceArtifactId: string; content: { kind: "plan"; summary: string; reproduction: string | null; rootCauseAnalysis: string | null; steps: Array<{ number: number; instruction: string; verification: string }>; compatibilityAnalysis: string; operationalAnalysis: string; verificationStrategy: string; unresolvedTechnicalQuestions: string[] } | { kind: "decision_blocker"; summary: string; evidence: string; owner: "human"; question: string; nextAction: string } } };

const DeveloperDiff = lazy(() => import("./components/app/developer-diff.js"));

const taskPhases: TaskPhase[] = ["backlog", "planning", "approval", "ready_for_development", "development", "delivery_ready", "reviewing_delivery", "repair_required", "delivery_reviewed", "releasing", "merge_conflict_reviewing", "merge_conflict_required", "merge_conflict_resolving", "ci_waiting", "ci_repair_planning", "ci_repairing", "ci_repair_required", "final_review", "accepted", "manual_merge", "done", "delivery_blocked", "cancelled", "failed"];

function taskPhaseLabel(phase: TaskPhase): string {
  const labels: Partial<Record<TaskPhase, string>> = {
    ready_for_development: "Ready",
    delivery_ready: "Delivered",
    reviewing_delivery: "Reviewing",
    repair_required: "Repair",
    delivery_reviewed: "Reviewed",
    delivery_blocked: "Blocked",
    merge_conflict_reviewing: "Reviewing conflict",
    merge_conflict_required: "Conflict resolution",
    merge_conflict_resolving: "Resolving conflict",
    ci_waiting: "Waiting for CI",
    ci_repair_required: "CI repair",
    final_review: "Final review",
    manual_merge: "Ready to merge",
  };
  return labels[phase] ?? phase.split("_").map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
}

async function reconcileScopedNotFound(reason: unknown, reloadCompanies: () => Promise<void>): Promise<boolean> {
  if (!isApiError(reason, 404)) return false;
  await reloadCompanies();
  return true;
}

function adminDate(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
}

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
        <div className="bg-card p-4">
          <div className="mb-5 flex items-center justify-between"><span className="text-[13px] font-semibold">{enrollment ? "Passkey enrollment" : "Passkey sign-in"}</span><span className="text-xs text-muted-foreground">No password</span></div>
          {enrollment ? <FieldGroup><Field><FieldLabel htmlFor="invitation">Invitation token</FieldLabel><Input id="invitation" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} /></Field><Button onClick={() => void enroll()} disabled={busy || token.length < 16}>{busy ? "Waiting for passkey…" : "Enroll passkey"}</Button></FieldGroup> : <Button className="w-full" onClick={() => void signIn()} disabled={busy}>{busy ? "Waiting for passkey…" : "Sign in with passkey"}</Button>}
          {error ? <Alert variant="destructive" className="mt-3 text-xs text-rose-700"><AlertDescription>{error}</AlertDescription></Alert> : null}
        </div>
      </div>
    </ApplicationFrame>
  );
}

function AdminView(): ReactElement {
  const { user, companies, currentCompany, loading } = useCompanyContext();
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [invitations, setInvitations] = useState<ApiInvitation[]>([]);
  const [credentials, setCredentials] = useState<ApiCredential[]>([]);
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
  const [models, setModels] = useState<ApiModel[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [profileName, setProfileName] = useState("");
  const [profileModel, setProfileModel] = useState("gpt-5.6-sol");
  const [profileReasoning, setProfileReasoning] = useState("medium");
  const [profilePriority, setProfilePriority] = useState("standard");
  const [profileCapacity, setProfileCapacity] = useState("2");
  const [modelId, setModelId] = useState("");
  const [modelName, setModelName] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [inviteExpiresAt, setInviteExpiresAt] = useState("");
  const [copied, setCopied] = useState(false);
  const [pendingAction, setPendingAction] = useState("");
  const [error, setError] = useState("");

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [userList, invitationList, credentialList, profileList, modelList] = await Promise.all([
        readJson<{ users: ApiUser[] }>("/api/admin/users"),
        readJson<{ invitations: ApiInvitation[] }>("/api/admin/invitations"),
        readJson<{ credentials: ApiCredential[] }>("/api/admin/credentials"),
        readJson<{ profiles: ApiProfile[] }>("/api/profiles").catch(() => ({ profiles: [] })),
        readJson<{ models: ApiModel[] }>("/api/admin/models").catch(() => ({ models: [] })),
      ]);
      setUsers(userList.users);
      setInvitations(invitationList.invitations);
      setCredentials(credentialList.credentials);
      setProfiles(profileList.profiles);
      setModels(modelList.models);
      const activeModels = modelList.models.filter((model) => model.status === "active");
      setProfileModel((current) => activeModels.some((model) => model.id === current) ? current : activeModels[0]?.id ?? "");
    } catch (reason) {
      if (reason instanceof Error && reason.message === "Authentication required") window.location.assign("/auth");
      else setError("Unable to load administration");
    }
  }, []);
  useEffect(() => { if (!loading && user?.role === "admin") void reload(); }, [loading, reload, user?.role]);

  const invite = async (): Promise<void> => {
    try {
      const result = await readJson<{ token: string; expiresAt: string }>("/api/admin/invitations", { method: "POST", body: JSON.stringify({ displayName: displayName || "Forge user" }) });
      setInviteToken(result.token);
      setInviteExpiresAt(result.expiresAt);
      setCopied(false);
      setDisplayName("");
      await reload();
    } catch { setError("Unable to invite user"); }
  };
  const copyInvitation = async (): Promise<void> => {
    if (!inviteToken) return;
    try {
      await navigator.clipboard.writeText(inviteToken);
      setCopied(true);
    } catch { setError("Unable to copy invitation"); }
  };
  const createProfile = async (): Promise<void> => {
    try { await readJson("/api/admin/profiles", { method: "POST", body: JSON.stringify({ name: profileName, model: profileModel, reasoningLevel: profileReasoning, servicePriority: profilePriority, capacity: Number(profileCapacity) }) }); setProfileName(""); await reload(); } catch { setError("Unable to create profile"); }
  };
  const createModel = async (): Promise<void> => {
    try {
      await readJson("/api/admin/models", { method: "POST", body: JSON.stringify({ id: modelId, displayName: modelName, description: "", sortOrder: 100 }) });
      setModelId(""); setModelName(""); await reload();
    } catch { setError("Unable to add model"); }
  };
  const toggleModel = async (model: ApiModel): Promise<void> => {
    try { await readJson(`/api/admin/models/${encodeURIComponent(model.id)}`, { method: "PATCH", body: JSON.stringify({ status: model.status === "active" ? "retired" : "active" }) }); await reload(); }
    catch { setError("Unable to update model"); }
  };
  const changeMembership = async (companyId: string, targetUserId: string, add: boolean): Promise<void> => {
    const action = `membership:${companyId}:${targetUserId}`;
    if (!add && pendingAction !== action) {
      setPendingAction(action);
      return;
    }
    try {
      const init: RequestInit = { method: add ? "POST" : "DELETE" };
      if (add) init.body = JSON.stringify({ userId: targetUserId });
      await readJson(add ? `/api/admin/companies/${companyId}/members` : `/api/admin/companies/${companyId}/members/${targetUserId}`, init);
      await reload();
      setPendingAction("");
    } catch { setError("Unable to change membership"); }
  };
  const revokeUser = async (candidate: ApiUser): Promise<void> => {
    const action = `user:${candidate.id}`;
    if (pendingAction !== action) {
      setPendingAction(action);
      return;
    }
    try {
      await readJson(`/api/admin/users/${candidate.id}/revoke`, { method: "POST", body: "{}" });
      setPendingAction("");
      await reload();
    } catch { setError("Unable to revoke user"); }
  };
  const revokeCredential = async (credential: ApiCredential): Promise<void> => {
    const action = `credential:${credential.id}`;
    if (pendingAction !== action) {
      setPendingAction(action);
      return;
    }
    try {
      await readJson(`/api/admin/credentials/${credential.id}/revoke`, { method: "POST", body: "{}" });
      setPendingAction("");
      await reload();
    } catch { setError("Unable to revoke passkey"); }
  };
  const signOut = async (): Promise<void> => { await readJson("/api/auth/sign-out", { method: "POST", body: "{}" }); window.localStorage.removeItem("forge.activeCompanyId"); window.location.assign("/auth"); };
  const isProfiles = window.location.pathname.endsWith("/profiles");
  const activeHref = withCompany(window.location.pathname, currentCompany?.id);
  const backHref = withCompany("/projects", currentCompany?.id);

  if (loading) {
    return (
      <SettingsLayout title={isProfiles ? "Profiles" : "Users"} companyId={currentCompany?.id ?? ""} backHref={backHref} activeHref={activeHref} contentClassName="">
        <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading administration"><Skeleton className="h-4 w-40" /><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-3/4" /></div>
      </SettingsLayout>
    );
  }
  if (user?.role !== "admin") {
    return (
      <SettingsLayout title={isProfiles ? "Profiles" : "Users"} companyId={currentCompany?.id ?? ""} backHref={backHref} activeHref={activeHref} contentClassName="">
        <div className="p-4 text-xs text-muted-foreground">Administration is unavailable.</div>
      </SettingsLayout>
    );
  }

  return (
    <SettingsLayout title={isProfiles ? "Profiles" : "Users"} companyId={currentCompany?.id ?? ""} backHref={backHref} activeHref={activeHref} contentClassName="">
      <div>{!isProfiles ? (<>
        <section className="flex flex-wrap items-center justify-between gap-3 px-3 py-3 sm:px-4"><span className="text-xs text-muted-foreground">{user?.displayName ?? ""} · {user?.role ?? ""}</span><Button variant="ghost" size="sm" onClick={() => void signOut()}>Sign out</Button></section>
        <section className="grid gap-px sm:grid-cols-2">
          <div className="bg-background p-4">
            <div className="mb-3 flex items-center justify-between"><span className="text-xs font-semibold">Users</span><span className="text-[11px] text-muted-foreground">{users.length}</span></div>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="invite-display-name">Display name</FieldLabel>
                <Input id="invite-display-name" placeholder="Forge user" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
              </Field>
              <Button size="sm" onClick={() => void invite()}>Invite</Button>
            </FieldGroup>
            {inviteToken ? <div className="bg-muted/30 p-2"><div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground"><span>Invitation · shown once</span><span>Expires {adminDate(inviteExpiresAt)}</span></div><code className="block break-all text-[11px]">{inviteToken}</code><Button className="mt-2" variant="outline" size="sm" onClick={() => void copyInvitation()}>{copied ? "Copied" : "Copy invitation"}</Button></div> : null}
            <div className="mt-3">{users.map((candidate) => <div className="flex min-h-8 items-center justify-between gap-2 text-xs" key={candidate.id}><span className="min-w-0 truncate">{candidate.displayName} <span className="text-muted-foreground">{candidate.status}</span></span>{candidate.role !== "admin" && candidate.status === "active" ? <span className="flex shrink-0 items-center gap-1">{pendingAction === `user:${candidate.id}` ? <span className="text-[11px] text-muted-foreground">Confirm</span> : null}<Button variant="ghost" size="sm" onClick={() => void revokeUser(candidate)}>{pendingAction === `user:${candidate.id}` ? "Confirm revoke" : "Revoke"}</Button>{pendingAction === `user:${candidate.id}` ? <Button variant="ghost" size="sm" onClick={() => setPendingAction("")}>Cancel</Button> : null}</span> : null}</div>)}</div>
          </div>
          <div className="bg-background p-4">
            <div className="mb-3 flex items-center justify-between"><span className="text-xs font-semibold">Companies</span><span className="text-[11px] text-muted-foreground">{companies.length}</span></div>
            <div>{companies.map((company) => <div className="py-2 text-xs" key={company.id}><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><span className="min-w-0 truncate"><span>{company.name}</span> <span className="text-muted-foreground">{company.status}</span></span><a className="flex h-7 items-center px-2 text-xs text-muted-foreground hover:text-foreground" href={withCompany(`/companies/${encodeURIComponent(company.id)}/settings`, company.id)}>Settings</a></div><div className="flex flex-wrap gap-1.5">{users.filter((candidate) => candidate.role === "member" && candidate.status === "active").map((candidate) => { const assigned = candidate.companyIds.includes(company.id); const action = `membership:${company.id}:${candidate.id}`; return <span className="flex items-center gap-1" key={candidate.id}><Button variant={assigned ? "secondary" : "outline"} size="sm" onClick={() => void changeMembership(company.id, candidate.id, !assigned)}>{assigned ? "− " : "+ "}{candidate.displayName}</Button>{pendingAction === action ? <><span className="text-[11px] text-muted-foreground">Confirm remove</span><Button variant="ghost" size="sm" onClick={() => setPendingAction("")}>Cancel</Button></> : null}</span>; })}</div></div>)}</div>
          </div>
        </section></>) : null}
        {!isProfiles ? <section className="grid gap-px sm:grid-cols-2">
          <div className="bg-background p-4"><div className="mb-3 flex items-center justify-between"><span className="text-xs font-semibold">Invitations</span><span className="text-[11px] text-muted-foreground">{invitations.length}</span></div><div>{invitations.map((invitation) => <div className="py-2 text-xs" key={invitation.id}><div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate">{invitation.displayName}</span><span className="shrink-0 text-muted-foreground">{invitation.status}</span></div><div className="mt-1 text-[11px] text-muted-foreground">{invitation.kind} · expires {adminDate(invitation.expiresAt)}</div></div>)}</div></div>
          <div className="bg-background p-4"><div className="mb-3 flex items-center justify-between"><span className="text-xs font-semibold">Passkeys</span><span className="text-[11px] text-muted-foreground">{credentials.filter((credential) => !credential.revokedAt).length} active</span></div><div>{credentials.map((credential) => { const candidate = users.find((entry) => entry.id === credential.userId); const action = `credential:${credential.id}`; return <div className="flex min-h-8 items-center justify-between gap-2 text-xs" key={credential.id}><span className="min-w-0 truncate">{candidate?.displayName ?? "User"}<span className="ml-2 text-muted-foreground">{credential.revokedAt ? "revoked" : `created ${adminDate(credential.createdAt)}`}</span></span>{!credential.revokedAt && credential.userId !== user.id ? <span className="flex shrink-0 items-center gap-1">{pendingAction === action ? <span className="text-[11px] text-muted-foreground">Confirm</span> : null}<Button variant="ghost" size="sm" onClick={() => void revokeCredential(credential)}>{pendingAction === action ? "Confirm revoke" : "Revoke"}</Button>{pendingAction === action ? <Button variant="ghost" size="sm" onClick={() => setPendingAction("")}>Cancel</Button> : null}</span> : null}</div>; })}</div></div>
        </section> : null}
        {isProfiles ? (<>
          <section className="bg-background p-4">
            <div className="mb-3 flex items-center justify-between"><span className="text-xs font-semibold">Codex profiles</span><span className="text-[11px] text-muted-foreground">{profiles.length} configured</span></div>
            <FieldGroup>
              <Field><FieldLabel htmlFor="profile-name">Profile name</FieldLabel><Input id="profile-name" value={profileName} onChange={(event) => setProfileName(event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="profile-model">Model</FieldLabel><Select value={profileModel || null} onValueChange={(value) => setProfileModel(value ?? "")}><SelectTrigger id="profile-model"><SelectValue placeholder="Select a model" /></SelectTrigger><SelectContent>{models.filter((model) => model.status === "active").map((model) => <SelectItem key={model.id} value={model.id}>{model.displayName} · {model.id}</SelectItem>)}</SelectContent></Select></Field>
              <Field><FieldLabel htmlFor="profile-reasoning">Reasoning level</FieldLabel><Select value={profileReasoning} onValueChange={(value) => setProfileReasoning(value ?? "medium")}><SelectTrigger id="profile-reasoning"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="low">Low</SelectItem><SelectItem value="medium">Medium</SelectItem><SelectItem value="high">High</SelectItem></SelectContent></Select></Field>
              <Field><FieldLabel htmlFor="profile-priority">Service priority</FieldLabel><Select value={profilePriority} onValueChange={(value) => setProfilePriority(value ?? "standard")}><SelectTrigger id="profile-priority"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="standard">Standard</SelectItem><SelectItem value="priority">Priority</SelectItem></SelectContent></Select></Field>
              <Field><FieldLabel htmlFor="profile-capacity">Capacity</FieldLabel><Input id="profile-capacity" inputMode="numeric" value={profileCapacity} onChange={(event) => setProfileCapacity(event.target.value)} /><FieldDescription>Maximum concurrent work slots.</FieldDescription></Field>
              <Button size="sm" onClick={() => void createProfile()} disabled={!profileName.trim() || !profileModel}>Create profile</Button>
            </FieldGroup>
            <div className="text-xs">{profiles.map((profile) => <div className="flex min-h-9 items-center justify-between gap-3" key={profile.id}><span className="font-medium">{profile.name}</span><span className="truncate text-[11px] text-muted-foreground">{profile.model} · {profile.reasoningLevel} · {profile.servicePriority} · {profile.capacity} slots</span></div>)}</div>
          </section>
          <section className="bg-background p-4">
            <div className="mb-1 flex items-center justify-between"><span className="text-xs font-semibold">Model catalog</span><span className="text-[11px] text-muted-foreground">Database backed</span></div>
            <p className="mb-3 text-[11px] text-muted-foreground">Models available when creating Codex profiles. Retiring a model preserves existing profiles.</p>
            <FieldGroup>
              <Field><FieldLabel htmlFor="model-id">Model ID</FieldLabel><Input id="model-id" placeholder="gpt-5-codex" value={modelId} onChange={(event) => setModelId(event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="model-display-name">Display name</FieldLabel><Input id="model-display-name" value={modelName} onChange={(event) => setModelName(event.target.value)} /></Field>
              <Button variant="outline" size="sm" onClick={() => void createModel()} disabled={!modelId.trim() || !modelName.trim()}>Add model</Button>
            </FieldGroup>
            <div>{models.map((model) => <div className="flex min-h-10 items-center justify-between gap-3 text-xs" key={model.id}><div className="min-w-0"><div className="font-medium">{model.displayName} <code className="ml-1 text-[11px] font-normal text-muted-foreground">{model.id}</code></div><div className="truncate text-[11px] text-muted-foreground">{model.description || "No description"}</div></div><Button variant="ghost" size="sm" onClick={() => void toggleModel(model)}>{model.status === "active" ? "Retire" : "Restore"}</Button></div>)}</div>
          </section>
        </>) : null}
        {error ? <Alert variant="destructive" className="px-4 py-3 text-xs text-rose-700"><AlertDescription>{error}</AlertDescription></Alert> : null}
      </div>
    </SettingsLayout>
  );
}

function CreateProjectDialog({
  open,
  onOpenChange,
  companyId,
  companyStatus,
  onCreated,
  reloadCompanies,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  companyStatus: CompanyStatus | undefined;
  onCreated: () => Promise<void>;
  reloadCompanies: () => Promise<void>;
}): ReactElement {
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [findings, setFindings] = useState<Array<{ field: string; message: string }>>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setRepositoryUrl("");
      setFindings([]);
      setError("");
      setBusy(false);
    }
  }, [open]);

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    if (!companyId || companyStatus !== "active" || !repositoryUrl.trim()) return;
    setBusy(true);
    setError("");
    setFindings([]);
    try {
      await readJson<ApiProject>(`/api/companies/${companyId}/projects`, {
        method: "POST",
        body: JSON.stringify({ repositoryUrl: repositoryUrl.trim() }),
      });
      await onCreated();
      onOpenChange(false);
    } catch (reason) {
      if (await reconcileScopedNotFound(reason, reloadCompanies)) return;
      setError(reason instanceof Error ? reason.message : "Project configuration failed");
      if (reason instanceof Error && "findings" in reason) setFindings((reason as Error & { findings?: Array<{ field: string; message: string }> }).findings ?? []);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(92vw,460px)]" showCloseButton>
        <DialogHeader><DialogTitle>New project</DialogTitle></DialogHeader>
          {companyStatus !== "active" ? (
            <p className="text-xs text-muted-foreground">{companyStatus === "paused" ? "Company paused. New projects are unavailable." : "Company archived. New projects are unavailable."}</p>
          ) : (
            <form className="grid gap-3" onSubmit={(event: FormEvent) => void submit(event)}>
              <Field>
                <FieldLabel htmlFor="project-repository-url">GitHub repository URL</FieldLabel>
                <Input id="project-repository-url" name="repositoryUrl" autoFocus autoComplete="off" spellCheck={false} placeholder="https://github.com/owner/repository" aria-describedby="project-repository-hint" value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} />
                <FieldDescription id="project-repository-hint">HTTPS and SSH URLs are supported. Forge clones into <span className="font-mono">~/forge/repos</span> and creates worktrees in <span className="font-mono">~/forge/worktrees</span>.</FieldDescription>
              </Field>
              <DialogFooter className="mt-1"><DialogClose render={<Button type="button" variant="ghost" size="sm">Cancel</Button>} /><Button type="submit" size="sm" disabled={busy || !companyId || !repositoryUrl.trim()}>{busy ? "Cloning…" : "Create project"}</Button></DialogFooter>
            </form>
          )}
          {error ? <Alert variant="destructive" className="mt-3 text-xs text-rose-700"><AlertDescription>{error}</AlertDescription></Alert> : null}
          {findings.length ? <ul className="mt-3 space-y-1 text-xs text-rose-700">{findings.map((item, index) => <li key={`${item.field}-${index}`}>{item.field}: {item.message}</li>)}</ul> : null}
      </DialogContent>
    </Dialog>
  );
}

type ProjectSettingsForm = {
  name: string;
  baseBranch: string;
  targetBranch: string;
  setupCommand: string;
  verificationCommand: string;
  requiredChecks: string;
  allowedProfileIds: string[];
  leadProfile: string;
  developerProfile: string;
  reviewerProfile: string;
};

type ActivationRequirement = { key: string; label: string; complete: boolean };

function activationRequirements(input: { requiredChecks: string[]; allowedProfileIds: string[]; leadProfile: string | undefined; developerProfile: string | undefined }): ActivationRequirement[] {
  return [
    { key: "checks", label: "Add at least one required GitHub check", complete: input.requiredChecks.length > 0 },
    { key: "profiles", label: "Allow at least one Codex profile", complete: input.allowedProfileIds.length > 0 },
    { key: "lead", label: "Choose a Lead default", complete: Boolean(input.leadProfile) },
    { key: "developer", label: "Choose a Developer default", complete: Boolean(input.developerProfile) },
  ];
}

function settingsForm(project: ApiProject, profiles: ApiProfile[]): ProjectSettingsForm {
  return {
    name: project.name,
    baseBranch: project.baseBranch,
    targetBranch: project.targetBranch,
    setupCommand: project.setupCommand,
    verificationCommand: project.verificationCommand,
    requiredChecks: project.requiredChecks.join(", "),
    allowedProfileIds: project.allowedProfileIds.length ? project.allowedProfileIds : profiles.map((profile) => profile.id),
    leadProfile: project.roleDefaults.lead ?? "",
    developerProfile: project.roleDefaults.developer ?? "",
    reviewerProfile: project.roleDefaults.reviewer ?? "",
  };
}

function ProjectSettingsDialog({
  project,
  profiles,
  onOpenChange,
  onSaved,
}: {
  project: ApiProject | undefined;
  profiles: ApiProfile[];
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}): ReactElement {
  const [form, setForm] = useState<ProjectSettingsForm | undefined>();
  const [findings, setFindings] = useState<Array<{ field: string; message: string }>>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkOptions, setCheckOptions] = useState<ApiCheck[]>([]);
  const [checksLoading, setChecksLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setForm(project ? settingsForm(project, profiles) : undefined);
    setFindings([]);
    setError("");
    setBusy(false);
    setCheckOptions([]);
    if (project) {
      setChecksLoading(true);
      void readJson<{ checks: ApiCheck[] }>(`/api/projects/${project.id}/checks`)
        .then((result) => {
          if (cancelled) return;
          setCheckOptions(result.checks);
          setForm((current) => current && current.requiredChecks.trim().length === 0
            ? { ...current, requiredChecks: result.checks.map((check) => check.name).join(", ") }
            : current);
        })
        .catch(() => { if (!cancelled) setCheckOptions([]); })
        .finally(() => { if (!cancelled) setChecksLoading(false); });
      if (project.status === "draft" && project.setupCommand === "pnpm install" && project.verificationCommand === "pnpm test") {
        void readJson<{ setupCommand: string; verificationCommand: string }>(`/api/projects/${project.id}/repository-defaults`)
          .then((defaults) => {
            if (!cancelled) setForm((current) => current ? { ...current, ...defaults } : current);
          })
          .catch(() => undefined);
      }
    }
    return () => { cancelled = true; };
  }, [project, profiles]);

  const setField = <Key extends keyof ProjectSettingsForm>(key: Key, value: ProjectSettingsForm[Key]): void => {
    setForm((current) => current ? { ...current, [key]: value } : current);
  };

  const toggleProfile = (profileId: string): void => {
    if (!form) return;
    const enabled = form.allowedProfileIds.includes(profileId);
    const allowedProfileIds = enabled ? form.allowedProfileIds.filter((id) => id !== profileId) : [...form.allowedProfileIds, profileId];
    setForm({
      ...form,
      allowedProfileIds,
      leadProfile: enabled && form.leadProfile === profileId ? "" : form.leadProfile,
      developerProfile: enabled && form.developerProfile === profileId ? "" : form.developerProfile,
      reviewerProfile: enabled && form.reviewerProfile === profileId ? "" : form.reviewerProfile,
    });
  };

  const toggleCheck = (checkName: string): void => {
    if (!form) return;
    const checks = form.requiredChecks.split(",").map((value) => value.trim()).filter(Boolean);
    setField("requiredChecks", (checks.includes(checkName) ? checks.filter((name) => name !== checkName) : [...checks, checkName]).join(", "));
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!project || !form) return;
    setBusy(true);
    setError("");
    setFindings([]);
    try {
      await readJson<ApiProject>(`/api/projects/${project.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: form.name,
          repositoryPath: project.repositoryPath,
          worktreeRoot: project.worktreeRoot,
          repository: project.repository ?? "",
          baseBranch: form.baseBranch,
          targetBranch: form.targetBranch,
          setupCommand: form.setupCommand,
          verificationCommand: form.verificationCommand,
          requiredChecks: form.requiredChecks.split(",").map((value) => value.trim()).filter(Boolean),
          allowedProfileIds: form.allowedProfileIds,
          roleDefaults: { lead: form.leadProfile, developer: form.developerProfile, reviewer: form.reviewerProfile },
        }),
      });
      await onSaved();
      onOpenChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Project configuration failed");
      if (reason instanceof Error && "findings" in reason) setFindings((reason as Error & { findings?: Array<{ field: string; message: string }> }).findings ?? []);
    } finally {
      setBusy(false);
    }
  };

  const allowedProfiles = profiles.filter((profile) => form?.allowedProfileIds.includes(profile.id));
  const requirements = form ? activationRequirements({
    requiredChecks: form.requiredChecks.split(",").map((value) => value.trim()).filter(Boolean),
    allowedProfileIds: form.allowedProfileIds,
    leadProfile: form.leadProfile,
    developerProfile: form.developerProfile,
  }) : [];
  const missingRequirements = requirements.filter((requirement) => !requirement.complete);
  const selectedChecks = form?.requiredChecks.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  const availableChecks: ApiCheck[] = [...new Map([...checkOptions, ...selectedChecks.map((name) => ({ name, status: "configured" } satisfies ApiCheck))].map((check) => [check.name, check])).values()];
  return (
    <Dialog open={Boolean(project)} onOpenChange={(open) => { if (!open) onOpenChange(false); }}>
      <DialogContent className="max-h-[85vh] w-[min(92vw,640px)] overflow-y-auto" showCloseButton>
        <DialogHeader><DialogTitle>Project settings</DialogTitle><DialogDescription>{project?.repository}</DialogDescription></DialogHeader>
          {project && form ? <form onSubmit={(event) => void submit(event)}>
            <FieldGroup>
              <div className={`grid gap-2 px-3 py-2 ${missingRequirements.length ? "bg-amber-50/70" : "bg-emerald-50/70"}`}>
                <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium">Activation requirements</span><span className={missingRequirements.length ? "text-[11px] font-medium text-amber-800" : "text-[11px] font-medium text-emerald-700"}>{missingRequirements.length ? `${missingRequirements.length} missing` : "Ready"}</span></div>
                <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-2">{requirements.map((requirement) => <li className={`flex items-center gap-1.5 text-[11px] ${requirement.complete ? "text-muted-foreground" : "font-medium text-amber-800"}`} key={requirement.key}><span className={`size-1.5 rounded-full ${requirement.complete ? "bg-emerald-500" : "bg-amber-500"}`} />{requirement.label}</li>)}</ul>
              </div>
              <Field><FieldLabel htmlFor="project-name">Project name</FieldLabel><Input id="project-name" autoFocus value={form.name} onChange={(event) => setField("name", event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="project-base-branch">Base branch</FieldLabel><Input id="project-base-branch" value={form.baseBranch} onChange={(event) => setField("baseBranch", event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="project-target-branch">Target branch</FieldLabel><Input id="project-target-branch" value={form.targetBranch} onChange={(event) => setField("targetBranch", event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="project-setup-command">Setup command</FieldLabel><Input id="project-setup-command" value={form.setupCommand} onChange={(event) => setField("setupCommand", event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="project-verification-command">Verification command</FieldLabel><Input id="project-verification-command" value={form.verificationCommand} onChange={(event) => setField("verificationCommand", event.target.value)} /></Field>
              <FieldSet>
                <FieldLegend variant="label">Required GitHub checks</FieldLegend>
                {checksLoading ? <FieldDescription>Loading checks from {project.targetBranch}…</FieldDescription> : availableChecks.length ? <FieldGroup data-slot="checkbox-group">{availableChecks.map((check, index) => <Field orientation="horizontal" key={check.name}><Checkbox id={`project-check-${index}`} checked={selectedChecks.includes(check.name)} onCheckedChange={() => toggleCheck(check.name)} /><FieldLabel htmlFor={`project-check-${index}`}>{check.name}{check.conclusion ? ` · ${check.conclusion}` : ""}</FieldLabel></Field>)}</FieldGroup> : <FieldDescription>No check runs were found on {project.targetBranch}. Run the repository workflows once, then reopen settings.</FieldDescription>}
                <FieldDescription>Exact check names fetched from GitHub for the target branch.</FieldDescription>
              </FieldSet>
              <FieldSet>
                <FieldLegend variant="label">Profiles</FieldLegend>
                {profiles.length ? <FieldGroup data-slot="checkbox-group">{profiles.map((profile) => <Field orientation="horizontal" key={profile.id}><Checkbox id={`project-profile-${profile.id}`} checked={form.allowedProfileIds.includes(profile.id)} onCheckedChange={() => toggleProfile(profile.id)} /><FieldLabel htmlFor={`project-profile-${profile.id}`}>{profile.name}</FieldLabel></Field>)}</FieldGroup> : <FieldDescription>No Codex profiles configured. <a href={withCompany("/admin/profiles", project.companyId)}>Create a profile</a> before activating this project.</FieldDescription>}
              </FieldSet>
              {(["leadProfile", "developerProfile", "reviewerProfile"] as const).map((key) => <Field key={key}><FieldLabel htmlFor={`project-${key}`}>{key === "leadProfile" ? "Lead default" : key === "developerProfile" ? "Developer default" : "Reviewer default (optional)"}</FieldLabel><Select value={form[key] || null} onValueChange={(value) => setField(key, value ?? "")}><SelectTrigger id={`project-${key}`}><SelectValue placeholder="None">{(value) => allowedProfiles.find((profile) => profile.id === value)?.name ?? (value ? "Unavailable profile" : "None")}</SelectValue></SelectTrigger><SelectContent><SelectItem value={null}>None</SelectItem>{allowedProfiles.map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>)}</SelectContent></Select></Field>)}
              <DialogFooter>{missingRequirements.length ? <span className="mr-auto text-[11px] text-amber-800">Complete the missing requirements to save.</span> : null}<DialogClose render={<Button type="button" variant="ghost" size="sm">Cancel</Button>} /><Button type="submit" size="sm" disabled={busy || missingRequirements.length > 0}>{busy ? "Saving…" : "Save settings"}</Button></DialogFooter>
            </FieldGroup>
          </form> : null}
          {error ? <Alert variant="destructive" className="mt-3 text-xs text-rose-700"><AlertDescription>{error}</AlertDescription></Alert> : null}
          {findings.length ? <ul className="mt-3 space-y-1 text-xs text-rose-700">{findings.map((item, index) => <li key={`${item.field}-${index}`}>{item.field}: {item.message}</li>)}</ul> : null}
      </DialogContent>
    </Dialog>
  );
}

function ProjectsView(): ReactElement {
  const { currentCompany, loading, user, error: companyError, reloadCompanies } = useCompanyContext();
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [loadedCompanyId, setLoadedCompanyId] = useState("");
  const [loadError, setLoadError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsProject, setSettingsProject] = useState<ApiProject>();
  const requestToken = useRef(0);
  const loadedCompanyIdRef = useRef("");
  const companyId = currentCompany?.id ?? "";

  const reload = useCallback(async (): Promise<void> => {
    const token = ++requestToken.current;
    setLoadError("");
    if (companyId !== loadedCompanyIdRef.current) {
      loadedCompanyIdRef.current = "";
      setLoadedCompanyId("");
      setProjects([]);
      setProfiles([]);
    }
    if (!companyId || loading) return;
    try {
      const [profileResult, projectResult] = await Promise.all([
        readJson<{ profiles: ApiProfile[] }>("/api/profiles"),
        readJson<{ projects: ApiProject[] }>(`/api/companies/${encodeURIComponent(companyId)}/projects`),
      ]);
      if (token !== requestToken.current) return;
      loadedCompanyIdRef.current = companyId;
      setProfiles(profileResult.profiles); setProjects(projectResult.projects); setLoadedCompanyId(companyId);
    } catch (reason) {
      if (token !== requestToken.current) return;
      if (reason instanceof Error && reason.message === "Authentication required") window.location.assign("/auth");
      else if (await reconcileScopedNotFound(reason, reloadCompanies)) return;
      else setLoadError("Unable to load projects");
    }
  }, [companyId, loading, reloadCompanies]);
  useEffect(() => { void reload(); }, [reload]);

  const visibleProjects = loadedCompanyId === companyId ? projects : [];

  const changeStatus = async (projectId: string, status: "activate" | "reactivate" | "pause" | "archive"): Promise<void> => {
    setLoadError("");
    try { await readJson(`/api/projects/${projectId}/${status}`, { method: "POST", body: "{}" }); await reload(); }
    catch (reason) { if (await reconcileScopedNotFound(reason, reloadCompanies)) return; setLoadError(reason instanceof Error ? reason.message : "Project update failed"); }
  };

  return (
    <ApplicationFrame title="Projects" headerRight={currentCompany?.status === "active" ? <CreateButton onClick={() => setCreateOpen(true)} disabled={!companyId}>Create</CreateButton> : undefined}>
      <div className="bg-background text-foreground">
        <section className="p-4">
          {currentCompany && currentCompany.status !== "active" ? <p className="mb-3 text-xs text-muted-foreground">{currentCompany.status === "paused" ? "Company paused. New projects are unavailable." : "Company archived. New projects are unavailable."}</p> : null}
          {currentCompany ? (
            <div>
              {visibleProjects.map((project) => { const requirements = activationRequirements({ requiredChecks: project.requiredChecks, allowedProfileIds: project.allowedProfileIds, leadProfile: project.roleDefaults.lead, developerProfile: project.roleDefaults.developer }); const missingRequirements = requirements.filter((requirement) => !requirement.complete); const ready = missingRequirements.length === 0; return <article className="py-3" key={project.id}><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><span className="text-[13px] font-medium">{project.name}</span>{project.status === "draft" ? <Badge variant="secondary" data-status="draft"><span className="size-1.5 rounded-full bg-amber-500" />Draft</Badge> : <Badge variant="secondary" data-status={project.status}>{project.status}</Badge>}<span className="text-[11px] text-muted-foreground">revision {project.configurationRevision}</span></div><div className="flex flex-wrap gap-1.5">{project.status === "draft" && ready ? <Button size="sm" onClick={() => void changeStatus(project.id, "activate")}>Activate</Button> : null}{project.status === "needs-reactivation" || project.status === "paused" ? <Button size="sm" onClick={() => void changeStatus(project.id, "reactivate")}>Reactivate</Button> : null}{project.status === "active" || project.status === "needs-reactivation" ? <Button variant="ghost" size="sm" onClick={() => void changeStatus(project.id, "pause")}>Pause</Button> : null}{project.status !== "archived" ? <Button variant={project.status === "draft" && !ready ? "default" : "ghost"} size="sm" onClick={() => setSettingsProject(project)}>Configure</Button> : null}{project.status !== "archived" ? <Button variant="ghost" size="sm" onClick={() => void changeStatus(project.id, "archive")}>Archive</Button> : null}<a className="flex h-7 items-center px-2 text-xs text-muted-foreground hover:text-foreground" href={`/api/projects/${project.id}`}>Inspect</a></div></div><div className="mt-2 grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2"><span className="truncate">{project.repositoryPath}</span><span className="truncate">{project.repository ?? "Repository not verified"}</span><span>Revision hash {project.configurationIdentity ? `${project.configurationIdentity.slice(0, 8)}…` : "unaccepted"}</span><span>Base {project.baseBranch} · {project.baseSha ? `${project.baseSha.slice(0, 8)}…` : "unaccepted"}</span><span>Target {project.targetBranch} · {project.targetSha ? `${project.targetSha.slice(0, 8)}…` : "unaccepted"}</span><span>{project.requiredChecks.length} required checks</span><span>Defaults: Lead {project.roleDefaults.lead ?? "—"} · Developer {project.roleDefaults.developer ?? "—"}</span>{project.status === "draft" && missingRequirements.length ? <span className="font-medium text-amber-700 sm:col-span-2">{missingRequirements.length} activation requirements missing: {missingRequirements.map((requirement) => requirement.label).join(" · ")}</span> : null}</div></article>; })}
              {!loading && loadedCompanyId === companyId && visibleProjects.length === 0 ? <div className="py-8 text-center text-xs text-muted-foreground">No projects configured.</div> : null}
            </div>
          ) : <p className="text-xs text-muted-foreground">{loading ? "Loading companies" : companyError ? "Unable to load companies" : user?.role === "admin" ? "Create a company to begin." : "No company access. Ask an administrator to assign a company."}</p>}
          {loadError ? <Alert variant="destructive" className="mt-3 text-xs text-rose-700"><AlertDescription>{loadError}</AlertDescription></Alert> : null}
        </section>
        <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} companyId={companyId} companyStatus={currentCompany?.status} onCreated={reload} reloadCompanies={reloadCompanies} />
        <ProjectSettingsDialog project={settingsProject} profiles={profiles} onOpenChange={() => setSettingsProject(undefined)} onSaved={reload} />
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

type TaskPlanAction = "request-supplemental-review" | "approve-plan" | "reject-plan" | "start-development" | "retry-development" | "cancel-development" | "review-delivery" | "repair-delivery" | "record-delivery-decision" | "publish-draft" | "resolve-merge-conflict" | "retry-target-base-reconciliation" | "retry-forward-merge-verification" | "reconcile-ci" | "repair-ci" | "final-review" | "accept-delivery" | "request-delivery-changes" | "reconcile-merge" | "cancel";

function TaskActions({ task, busy, onStartPlanning, onPlanAction }: { task: ApiTask; busy: boolean; onStartPlanning: () => Promise<void>; onPlanAction: (path: TaskPlanAction, note?: string) => Promise<void> }): ReactElement {
  const disabled = busy || task.projection.status === "lagging";
  return (
    <div data-task-actions className="flex flex-wrap justify-end gap-2">
      {task.allowedCommands.includes("start_planning") ? <Button size="sm" onClick={() => void onStartPlanning()} disabled={disabled}>{busy ? "Planning…" : "Start planning"}</Button> : null}
      {task.allowedCommands.includes("request_supplemental_review") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("request-supplemental-review")} disabled={disabled}>Request review</Button> : null}
      {task.allowedCommands.includes("approve_plan") ? <Button size="sm" onClick={() => void onPlanAction("approve-plan", "Approved final plan")} disabled={disabled}>Approve plan</Button> : null}
      {task.allowedCommands.includes("reject_plan") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("reject-plan", "Please revise the plan")} disabled={disabled}>Request changes</Button> : null}
      {task.allowedCommands.includes("start_development") ? <Button size="sm" onClick={() => void onPlanAction("start-development")} disabled={disabled}>{busy ? "Executing…" : "Start development"}</Button> : null}
      {task.allowedCommands.includes("retry_development") ? <Button size="sm" onClick={() => void onPlanAction("retry-development")} disabled={disabled}>{busy ? "Retrying…" : "Retry development"}</Button> : null}
      {task.allowedCommands.includes("cancel_development") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("cancel-development")} disabled={disabled}>Cancel development</Button> : null}
      {task.allowedCommands.includes("review_delivery") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("reject-plan", "Member requested delivery changes")} disabled={disabled}>Request changes</Button> : null}
      {task.allowedCommands.includes("review_delivery") ? <Button size="sm" onClick={() => void onPlanAction("review-delivery")} disabled={disabled}>{busy ? "Reviewing…" : "LGTM"}</Button> : null}
      {task.allowedCommands.includes("repair_delivery") ? <Button size="sm" onClick={() => void onPlanAction("repair-delivery")} disabled={disabled}>{busy ? "Repairing…" : "Repair delivery"}</Button> : null}
      {task.allowedCommands.includes("record_delivery_decision") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("record-delivery-decision", "Member decision recorded")} disabled={disabled}>Record decision</Button> : null}
      {task.allowedCommands.includes("publish_draft") ? <Button size="sm" onClick={() => void onPlanAction("publish-draft")} disabled={disabled}>{busy ? "Publishing…" : task.release?.status === "blocked" ? "Retry release" : "Publish draft"}</Button> : null}
      {task.allowedCommands.includes("resolve_merge_conflict") ? <Button size="sm" onClick={() => void onPlanAction("resolve-merge-conflict")} disabled={disabled}>{busy ? "Resolving…" : "Resolve conflicts"}</Button> : null}
      {task.allowedCommands.includes("retry_target_base_reconciliation") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("retry-target-base-reconciliation")} disabled={disabled}>{busy ? "Retrying…" : "Retry reconciliation"}</Button> : null}
      {task.allowedCommands.includes("retry_forward_merge_verification") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("retry-forward-merge-verification")} disabled={disabled}>{busy ? "Verifying…" : "Retry verification"}</Button> : null}
      {task.allowedCommands.includes("reconcile_ci") ? <Button size="sm" onClick={() => void onPlanAction("reconcile-ci")} disabled={disabled}>{busy ? "Checking…" : "Check CI"}</Button> : null}
      {task.allowedCommands.includes("repair_ci") ? <Button size="sm" onClick={() => void onPlanAction("repair-ci")} disabled={disabled}>{busy ? "Repairing…" : "Repair CI"}</Button> : null}
      {task.allowedCommands.includes("final_review") ? <Button size="sm" onClick={() => void onPlanAction("final-review")} disabled={disabled}>{busy ? "Reviewing…" : "Final review"}</Button> : null}
      {task.allowedCommands.includes("request_delivery_changes") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("request-delivery-changes", "Member requested delivery changes")} disabled={disabled}>Request changes</Button> : null}
      {task.allowedCommands.includes("accept_delivery") ? <Button size="sm" onClick={() => void onPlanAction("accept-delivery")} disabled={disabled}>{busy ? "Accepting…" : "Accept delivery"}</Button> : null}
      {task.allowedCommands.includes("reconcile_merge") ? <Button size="sm" onClick={() => void onPlanAction("reconcile-merge")} disabled={disabled}>{busy ? "Checking…" : "Check merge"}</Button> : null}
      {task.allowedCommands.includes("cancel_issue") ? <Button size="sm" variant="ghost" onClick={() => void onPlanAction("cancel")} disabled={disabled}>Cancel</Button> : null}
    </div>
  );
}

function ReleasePanel({ release }: { release: ApiRelease }): ReactElement {
  const copy = (value: string): void => { void navigator.clipboard?.writeText(value); };
  const statusLabel = release.status === "draft" ? "Draft" : release.status === "reconciling" ? "Reconciling" : "Blocked";
  return <section className="space-y-2" aria-label="Draft publication">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-xs font-semibold">Draft publication</h3><Badge variant={release.status === "blocked" ? "destructive" : "secondary"}>{statusLabel}</Badge></div>
    <div className="text-[13px]">{release.repository} · {release.baseBranch} ← {release.headBranch}</div>
    <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground"><Button variant="ghost" size="sm" title={release.reviewedCommit.full} aria-label={`Copy reviewed commit ${release.reviewedCommit.full}`} onClick={() => copy(release.reviewedCommit.full)}>{release.reviewedCommit.abbreviated}</Button><Button variant="ghost" size="sm" title={release.reviewedTree.full} aria-label={`Copy reviewed tree ${release.reviewedTree.full}`} onClick={() => copy(release.reviewedTree.full)}>{release.reviewedTree.abbreviated}</Button></div>
    {release.pullRequestUrl ? <a className="text-xs underline underline-offset-2" href={release.pullRequestUrl} target="_blank" rel="noreferrer">Pull request #{release.pullRequestNumber}</a> : null}
    {release.failureSummary ? <Alert variant="destructive"><AlertDescription>{release.failureCode ? releaseFailureCopy[release.failureCode] ?? "Release publication is blocked." : release.failureSummary}{release.retryAt ? ` Retry after ${adminDate(release.retryAt)}.` : ""}</AlertDescription></Alert> : null}
    {release.operation ? <div className="text-[11px] text-muted-foreground">{release.operation.kind} · attempt {release.operation.attempt ?? "—"} · {release.operation.status}</div> : null}
    <Collapsible.Root>
      <Collapsible.Trigger className="text-xs underline underline-offset-2">Preview title and body</Collapsible.Trigger>
      <Collapsible.Panel className="mt-2 min-w-0 whitespace-pre-wrap break-words border-l pl-3 text-[11px] text-muted-foreground">{release.title}{release.bodyPreview ? `\n\n${release.bodyPreview}` : "\n\nBody is not available."}</Collapsible.Panel>
    </Collapsible.Root>
  </section>;
}

function CiPanel({ task, ci }: { task: ApiTask; ci: ApiCi }): ReactElement {
  const latestAttempt = ci.attempts[0];
  return <section className="space-y-3 border-y py-3" data-task-ci>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-xs font-semibold">Exact-head CI</h3><div className="flex items-center gap-2"><Badge variant={ci.outcome === "failed" ? "destructive" : "secondary"}>{ci.outcome ?? ci.status}</Badge><a className="text-xs underline" href={ci.pullRequestUrl} target="_blank" rel="noreferrer">PR #{ci.pullRequestNumber}</a></div></div>
    <div className="grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-2"><span title={ci.expectedHeadSha}>Expected {ci.expectedHeadSha.slice(0, 10)}…</span><span title={latestAttempt?.observedHeadSha ?? undefined}>Observed {latestAttempt?.observedHeadSha ? `${latestAttempt.observedHeadSha.slice(0, 10)}…` : "—"}</span><span>Revision {ci.policy.projectRevisionId.slice(0, 10)}… · policy {ci.policyHash.slice(0, 8)}…</span><span>{ci.baseBranch} → {ci.headBranch} · {ci.repository}</span></div>
    <div className="space-y-1"><div className="text-[11px] font-medium">Required checks</div>{ci.policy.requiredChecks.map((name) => { const check = latestAttempt?.checks.find((candidate) => candidate.name === name && candidate.selectedForEvaluation); return <div className="flex items-center justify-between gap-2 border-b py-1 text-[11px]" key={name}><span className="min-w-0 break-words">{name}</span><span className="shrink-0 text-muted-foreground">{check ? `${check.status}${check.conclusion ? ` · ${check.conclusion}` : ""}` : "missing"}</span></div>; })}</div>
    <div className="grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2"><span>Next retry {ci.nextRetryAt ? adminDate(ci.nextRetryAt) : "—"}</span><span>Propagation {ci.propagationDeadline ? adminDate(ci.propagationDeadline) : "—"}</span><span>Overall deadline {ci.overallDeadline ? adminDate(ci.overallDeadline) : "—"}</span><span>Owner {ci.owner ?? "—"}</span></div>
    {ci.reason || latestAttempt?.summary ? <p className="break-words text-[12px]">{ci.reason ? `${ci.reason}: ` : ""}{latestAttempt?.summary ?? ""}</p> : null}
    <div className="flex flex-wrap gap-2 text-[11px]">{latestAttempt?.evidenceArtifactId ? <a className="underline" href={`/api/tasks/${task.id}/artifacts/${latestAttempt.evidenceArtifactId}`}>CI evidence</a> : null}{ci.repairPlan ? <a className="underline" href={`/api/tasks/${task.id}/artifacts/${ci.repairPlan.planArtifactId}`}>Repair plan · {ci.repairPlan.status}</a> : null}<span>Lead continuity {ci.leadSessionContinuity ? "verified" : "—"}</span><span>Developer continuity {ci.developerSessionContinuity ? "verified" : "—"}</span></div>
  </section>;
}

function TaskOptions(): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Task options" title="Task options" />}><Ellipsis /></DropdownMenuTrigger>
      <DropdownMenuContent align="start"><DropdownMenuItem disabled>Coming soon</DropdownMenuItem></DropdownMenuContent>
    </DropdownMenu>
  );
}

function TaskDetailsPage({ task, project, busy, error, onStartPlanning, onPlanAction }: { task: ApiTask; project: ApiProject | undefined; busy: boolean; error: string; onStartPlanning: () => Promise<void>; onPlanAction: (path: TaskPlanAction, note?: string) => Promise<void> }): ReactElement {
  return (
    <ApplicationFrame title={task.title} headerActions={<TaskOptions />}>
      <article data-task-detail className="min-w-0">
        <div data-task-body className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="min-w-0">
            <header className="px-4 pt-4 pb-3 sm:px-6 lg:px-10">
              <div data-task-header-content className="mx-auto max-w-4xl space-y-4">
                <div className="flex min-w-0 flex-wrap items-center gap-2"><h2 className="text-xl font-semibold tracking-tight">{task.title}</h2><Badge variant="secondary" data-status={task.phase}>{taskPhaseLabel(task.phase)}</Badge></div>
                <div aria-live="polite" className="text-[11px] text-muted-foreground">{task.projection.status === "lagging" ? `Projection lag: r${task.projection.projectedRevision} → r${task.projection.authoritativeRevision}` : `Projection current · r${task.projection.projectedRevision}`}</div>
                <TaskActions task={task} busy={busy} onStartPlanning={onStartPlanning} onPlanAction={onPlanAction} />
                {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
              </div>
            </header>
            <div data-task-content className="min-w-0 px-4 pt-4 pb-6 sm:px-6 lg:px-10">
              <div data-task-content-inner className="mx-auto max-w-4xl space-y-7">
                <pre className="whitespace-pre-wrap font-sans text-[13px] leading-5">{task.description || "No description."}</pre>
                <TaskProgress phase={task.phase} allowedCommands={task.allowedCommands} createdAt={task.createdAt} updatedAt={task.updatedAt} timeline={task.timeline} />
                {task.images.length ? <section className="space-y-2"><h3 className="text-xs font-semibold">Attachments</h3><div className="flex flex-wrap gap-3">{task.images.map((image) => <a className="text-xs underline underline-offset-2" href={`/api/tasks/${task.id}/images/${image.artifactId}`} target="_blank" rel="noreferrer" key={image.artifactId}>{image.filename}</a>)}</div></section> : null}
                {task.leadOutput ? <TaskLeadPlan output={task.leadOutput} planRevision={task.planRevision} planMaterial={task.planMaterial} materialCategories={task.materialCategories ?? []} /> : null}
                {task.developerExecution ? <section className="space-y-3"><div className="flex items-center justify-between gap-3"><h3 className="text-xs font-semibold">Developer delivery</h3><Badge variant="secondary">{task.developerExecution.status}</Badge></div><div className="text-[13px]">{task.developerExecution.failureSummary ?? task.pendingAction}</div><div className="text-[11px] text-muted-foreground">{task.developerExecution.branchName} · {task.developerExecution.resultCommit ?? "no commit yet"}</div>{task.developerExecution.status === "completed" ? <Suspense fallback={<Skeleton className="h-40 w-full" />}><DeveloperDiff taskId={task.id} executionId={task.developerExecution.id} /></Suspense> : null}</section> : null}
                {task.deliveryReview ? <section className="space-y-2"><div className="flex items-center justify-between gap-3"><h3 className="text-xs font-semibold">Delivery review</h3><Badge variant={task.deliveryReview.outcome === "blocking" ? "destructive" : "secondary"}>{task.deliveryReview.outcome}</Badge></div><div className="text-[13px]">{task.deliveryReview.summary}</div><div className="space-y-2">{task.deliveryReview.findings.map((finding) => <div className="pl-2 text-[13px]" key={finding.id}><div className="font-medium">{finding.severity} · {finding.disposition}</div><div className="text-[11px] text-muted-foreground">{finding.rationale}</div></div>)}</div></section> : null}
                {task.ci ? <CiPanel task={task} ci={task.ci} /> : null}
                {task.release ? <ReleasePanel release={task.release} /> : null}
                {task.targetBaseReconciliation.status ? <section className="space-y-2"><div className="flex items-center justify-between gap-3"><h3 className="text-xs font-semibold">Target-base reconciliation</h3><Badge variant={task.targetBaseReconciliation.status === "blocked" ? "destructive" : "secondary"}>{task.targetBaseReconciliation.status}</Badge></div><div className="text-[11px] text-muted-foreground">{task.targetBaseReconciliation.checkpoint ?? "checkpoint unavailable"}{task.targetBaseReconciliation.conflictFileCount !== null ? ` · ${task.targetBaseReconciliation.conflictFileCount} conflict files` : ""}</div><dl className="grid gap-1 text-[11px] sm:grid-cols-2"><div><dt className="text-muted-foreground">Expected base</dt><dd><code>{task.targetBaseReconciliation.expectedBaseSha?.slice(0, 12) ?? "—"}</code></dd></div><div><dt className="text-muted-foreground">Observed base</dt><dd><code>{task.targetBaseReconciliation.observedBaseSha?.slice(0, 12) ?? "—"}</code></dd></div><div><dt className="text-muted-foreground">Result</dt><dd><code>{task.targetBaseReconciliation.resultHead?.slice(0, 12) ?? "—"}</code></dd></div><div><dt className="text-muted-foreground">Verification</dt><dd>{task.targetBaseReconciliation.verificationArtifact ? <a className="underline" href={`/api/tasks/${task.id}/reconciliation-artifacts/${task.targetBaseReconciliation.verificationArtifact.id}`} target="_blank" rel="noreferrer">Evidence</a> : "—"}</dd></div></dl>{task.targetBaseReconciliation.releaseId && task.targetBaseReconciliation.pullRequestUrl ? <div className="text-[11px]"><a className="underline" href={task.targetBaseReconciliation.pullRequestUrl} target="_blank" rel="noreferrer">PR #{task.targetBaseReconciliation.pullRequestNumber}</a> · same PR continuity</div> : null}{task.targetBaseReconciliation.summary ? <div className="text-[12px] text-muted-foreground">{task.targetBaseReconciliation.summary}</div> : null}</section> : null}
                <TaskHistory activity={task.timeline} invocations={task.agentInvocations} />
              </div>
            </div>
          </div>
          <aside data-task-properties className="border-border border-t bg-muted/20 px-4 py-6 sm:px-6 lg:sticky lg:top-0 lg:h-fit lg:border-t-0 lg:border-l">
            <h3 className="mb-5 text-xs font-semibold">Properties</h3>
            <dl className="space-y-4 text-xs">
              <div className="space-y-1"><dt className="text-muted-foreground">Status</dt><dd><Badge variant="secondary">{taskPhaseLabel(task.phase)}</Badge></dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Project</dt><dd>{project?.name ?? "Unknown project"}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Owner</dt><dd>{task.owner}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Next action</dt><dd>{task.pendingAction ?? "None"}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Projection</dt><dd>{task.projection.status === "lagging" ? `Lagging r${task.projection.projectedRevision} → r${task.projection.authoritativeRevision}` : `Current · r${task.projection.projectedRevision}`}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Created</dt><dd>{adminDate(task.createdAt)}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Updated</dt><dd>{adminDate(task.updatedAt)}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Task ID</dt><dd><code className="break-all text-[11px]">{task.id}</code></dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Workflow</dt><dd><code className="break-all text-[11px]">{task.workflowId}</code></dd></div>
            </dl>
          </aside>
        </div>
      </article>
    </ApplicationFrame>
  );
}

function TaskDetailsSkeleton(): ReactElement {
  return <ApplicationFrame title="Task"><div data-task-detail-loading className="grid gap-8 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_260px] lg:px-10" aria-busy="true" aria-label="Loading task"><div className="space-y-4"><Skeleton className="h-4 w-40" /><Skeleton className="h-8 w-3/4" /><Skeleton className="h-24 w-full" /><Skeleton className="h-40 w-full" /></div><div className="space-y-3"><Skeleton className="h-4 w-24" /><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-3/4" /></div></div></ApplicationFrame>;
}

function TaskDetailsNotFound({ companyId, returnTo = "tasks" }: { companyId: string; returnTo?: "tasks" | "board" }): ReactElement {
  return <ApplicationFrame title="Task not found"><div className="space-y-3 px-4 py-8 sm:px-6 lg:px-10"><p className="text-xs text-muted-foreground">Task not found for this company.</p><a className="text-xs underline underline-offset-2" href={withCompany(`/${returnTo}`, companyId)}>Back to {returnTo === "board" ? "Board" : "Tasks"}</a></div></ApplicationFrame>;
}

type TaskListFilter = "active" | "backlog" | "all";

const activeTaskPhases = new Set<TaskPhase>(["planning", "approval", "ready_for_development", "development", "delivery_ready", "reviewing_delivery", "repair_required", "delivery_reviewed", "releasing", "merge_conflict_reviewing", "merge_conflict_required", "merge_conflict_resolving", "ci_waiting", "ci_repair_required", "final_review", "accepted", "manual_merge"]);
const blockedTaskPhases = new Set<TaskPhase>(["delivery_blocked", "failed"]);

function taskListDate(timestamp: string): string {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return relativeTime(timestamp);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function taskPhaseAppearance(phase: TaskPhase): { icon: LucideIcon; iconClass: string; badge: "secondary" | "success-light" | "warning-light" | "destructive-light" | "primary-light" } {
  if (phase === "done") return { icon: CheckCircle2, iconClass: "text-emerald-500", badge: "success-light" };
  if (blockedTaskPhases.has(phase) || phase === "cancelled") return { icon: CircleX, iconClass: "text-rose-500", badge: "destructive-light" };
  if (["development", "repair_required", "releasing", "merge_conflict_resolving", "ci_repair_required"].includes(phase)) return { icon: CircleDotDashed, iconClass: "text-amber-500", badge: "warning-light" };
  if (["approval", "ready_for_development", "delivery_ready", "reviewing_delivery", "delivery_reviewed", "final_review", "accepted", "manual_merge"].includes(phase)) return { icon: CircleDotDashed, iconClass: "text-blue-500", badge: "primary-light" };
  return { icon: CircleDashed, iconClass: "text-muted-foreground", badge: "secondary" };
}

function NewTaskDialog({ open, onOpenChange, companyName, companyStatus, projects, projectId, onProjectChange, title, onTitleChange, description, onDescriptionChange, images, onAddImages, onRemoveImage, busy, error, onSubmit }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyName: string | undefined;
  companyStatus: CompanyStatus | undefined;
  projects: ApiProject[];
  projectId: string;
  onProjectChange: (projectId: string) => void;
  title: string;
  onTitleChange: (title: string) => void;
  description: string;
  onDescriptionChange: (description: string) => void;
  images: Array<{ filename: string; mimeType: string; base64: string }>;
  onAddImages: (files: File[]) => Promise<void>;
  onRemoveImage: (index: number) => void;
  busy: boolean;
  error: string;
  onSubmit: () => Promise<void>;
}): ReactElement {
  const active = companyStatus === "active";
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!busy) onOpenChange(nextOpen); }}>
      <DialogContent className="max-h-[85vh] w-[min(92vw,520px)] overflow-y-auto" showCloseButton>
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>{companyName ? `Create in ${companyName}.` : "Select a company to create a task."}</DialogDescription>
        </DialogHeader>
        {active ? (
          <form onSubmit={(event) => { event.preventDefault(); void onSubmit(); }}>
            <FieldGroup>
              <Field><FieldLabel htmlFor="task-project">Project</FieldLabel><Select value={projectId || null} onValueChange={(value) => onProjectChange(value ?? "")}><SelectTrigger id="task-project"><SelectValue placeholder="Select a project">{(value) => projects.find((project) => project.id === value)?.name ?? (value ? "Unavailable project" : "Select a project")}</SelectValue></SelectTrigger><SelectContent>{projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent></Select></Field>
              <Field><FieldLabel htmlFor="task-title">Task title</FieldLabel><Input id="task-title" autoFocus value={title} onChange={(event) => onTitleChange(event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="task-description">Task description</FieldLabel><Textarea id="task-description" placeholder="Markdown description" value={description} onChange={(event) => onDescriptionChange(event.target.value)} /></Field>
              <InlineAttachmentPicker attachments={images.map((image, index) => ({ id: `${image.filename}-${image.base64.length}-${index}`, filename: image.filename, previewUrl: `data:${image.mimeType};base64,${image.base64}` }))} onSelect={onAddImages} onRemove={onRemoveImage} disabled={busy} />
            </FieldGroup>
            {error ? <Alert variant="destructive" className="mt-3"><AlertDescription>{error}</AlertDescription></Alert> : null}
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="ghost" size="sm">Cancel</Button>} />
              <Button type="submit" size="sm" disabled={busy || !projectId || !title.trim() || !description.trim()}>{busy ? "Saving…" : "Create task"}</Button>
            </DialogFooter>
          </form>
        ) : <p className="text-xs text-muted-foreground">{companyStatus === "paused" ? "Company paused. New tasks are unavailable." : companyStatus === "archived" ? "Company archived. New tasks are unavailable." : "No active company is available."}</p>}
      </DialogContent>
    </Dialog>
  );
}

function TasksView({ mode = "tasks" }: { mode?: "tasks" | "board" }): ReactElement {
  const { currentCompany, loading, user, error: companyError, reloadCompanies } = useCompanyContext();
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [tasks, setTasks] = useState<ApiTask[]>([]);
  const [loadedCompanyId, setLoadedCompanyId] = useState("");
  const [selectedState, setSelected] = useState<ApiTask>();
  const [projectId, setProjectId] = useState("");
  const [boardProjectId, setBoardProjectId] = useState("all");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [images, setImages] = useState<Array<{ filename: string; mimeType: string; base64: string }>>([]);
  const [error, setError] = useState("");
  const [createError, setCreateError] = useState("");
  const [createOpen, setCreateOpen] = useState(() => mode === "tasks" && new URLSearchParams(window.location.search).get("new") === "1");
  const [taskFilter, setTaskFilter] = useState<TaskListFilter>("all");
  const [busy, setBusy] = useState(false);
  const [detailNotFound, setDetailNotFound] = useState(false);
  const selectedRef = useRef<ApiTask | undefined>(undefined);
  const requestToken = useRef(0);
  const companyId = currentCompany?.id ?? "";

  useEffect(() => { selectedRef.current = selectedState; }, [selectedState]);

  const reload = useCallback(async (): Promise<void> => {
    const token = ++requestToken.current;
    setError("");
    if (!companyId || loading) { setLoadedCompanyId(""); setProjects([]); setTasks([]); return; }
    try {
      const [projectResult, taskResult] = await Promise.all([
        readJson<{ projects: ApiProject[] }>(`/api/companies/${encodeURIComponent(companyId)}/projects`),
        readJson<{ tasks: ApiTask[] }>(`/api/companies/${encodeURIComponent(companyId)}/tasks`),
      ]);
      if (token !== requestToken.current) return;
      setProjects(projectResult.projects); setTasks(taskResult.tasks);
      setProjectId((current) => projectResult.projects.some((project) => project.id === current && project.status === "active") ? current : projectResult.projects.find((project) => project.status === "active")?.id ?? "");
      const detailPrefix = mode === "board" ? "/board/" : "/tasks/";
      const routeTaskId = window.location.pathname.startsWith(detailPrefix) ? decodeURIComponent(window.location.pathname.slice(detailPrefix.length)) : "";
      const nextSelected = routeTaskId ? taskResult.tasks.find((task) => task.id === routeTaskId) : selectedRef.current ? taskResult.tasks.find((task) => task.id === selectedRef.current!.id) : undefined;
      setSelected(nextSelected);
      setDetailNotFound(Boolean(routeTaskId) && !nextSelected);
      setLoadedCompanyId(companyId);
    } catch (reason) {
      if (token !== requestToken.current) return;
      if (reason instanceof Error && reason.message === "Authentication required") window.location.assign("/auth");
      else if (await reconcileScopedNotFound(reason, reloadCompanies)) return;
      else setError("Unable to load tasks");
    }
  }, [companyId, loading, mode, reloadCompanies]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (mode !== "tasks") return;
    const openNewTask = (): void => { setCreateError(""); setCreateOpen(true); };
    window.addEventListener("forge:new-task", openNewTask);
    const url = new URL(window.location.href);
    if (url.searchParams.get("new") === "1") {
      openNewTask();
      url.searchParams.delete("new");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    return () => window.removeEventListener("forge:new-task", openNewTask);
  }, [mode]);
  useEffect(() => {
    selectedRef.current = undefined;
    setSelected(undefined); setProjectId(""); setTitle(""); setDescription(""); setImages([]); setCreateError(""); setDetailNotFound(false);
  }, [companyId]);
  useEffect(() => {
    const events = new EventSource("/api/tasks/events");
    events.addEventListener("ready", () => void reload());
    events.addEventListener("invalidate", () => void reload());
    return () => events.close();
  }, [reload]);

  const scopeLoaded = Boolean(companyId) && loadedCompanyId === companyId;
  const routeBase = mode === "board" ? "/board" : "/tasks";
  const detailPrefix = `${routeBase}/`;
  const routeTaskId = window.location.pathname.startsWith(detailPrefix) ? decodeURIComponent(window.location.pathname.slice(detailPrefix.length)) : "";
  const visibleProjects = scopeLoaded ? projects : [];
  const visibleTasks = scopeLoaded ? tasks : [];
  const boardTasks = boardProjectId === "all" ? visibleTasks : visibleTasks.filter((task) => task.projectId === boardProjectId);
  const taskBoard = Object.fromEntries(taskPhases.map((phase) => [phase, boardTasks.filter((task) => task.phase === phase)])) as Record<(typeof taskPhases)[number], ApiTask[]>;
  const selected = scopeLoaded ? selectedState : undefined;
  const availableProjects = visibleProjects.filter((project) => project.companyId === companyId && project.status === "active");
  const activeCount = visibleTasks.filter((task) => activeTaskPhases.has(task.phase)).length;
  const backlogCount = visibleTasks.filter((task) => task.phase === "backlog").length;
  const taskGroups = [
    { id: "active", title: "In progress", phases: activeTaskPhases, tasks: visibleTasks.filter((task) => activeTaskPhases.has(task.phase)) },
    { id: "backlog", title: "Backlog", phases: new Set<TaskPhase>(["backlog"]), tasks: visibleTasks.filter((task) => task.phase === "backlog") },
    { id: "blocked", title: "Blocked", phases: blockedTaskPhases, tasks: visibleTasks.filter((task) => blockedTaskPhases.has(task.phase)) },
    { id: "completed", title: "Completed", phases: new Set<TaskPhase>(["done", "cancelled"]), tasks: visibleTasks.filter((task) => task.phase === "done" || task.phase === "cancelled") },
  ].filter((group) => taskFilter === "all" ? group.tasks.length > 0 : group.id === taskFilter).map((group) => ({ ...group, tasks: [...group.tasks].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)) }));
  const selectTask = (task: ApiTask): void => { setSelected(task); selectedRef.current = task; setDetailNotFound(false); window.history.pushState({}, "", withCompany(`${routeBase}/${encodeURIComponent(task.id)}`, companyId)); };
  const addImages = async (files: File[]): Promise<void> => {
    setCreateError("");
    if (images.length + files.length > 8) { setCreateError("At most eight images may be attached"); return; }
    if (files.some((file) => !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type))) { setCreateError("Only PNG, JPEG, WebP, and GIF images are accepted"); return; }
    if (files.some((file) => file.size > 9_000_000)) { setCreateError("Each image must be smaller than 9 MB"); return; }
    try { const nextImages = await Promise.all(files.map(fileAsImage)); setImages((current) => [...current, ...nextImages]); }
    catch { setCreateError("Unable to read image"); }
  };
  const create = async (): Promise<void> => {
    if (!companyId || currentCompany?.status !== "active") return;
    setBusy(true); setCreateError("");
    try {
      const result = await readJson<ApiTask>(`/api/companies/${companyId}/tasks`, { method: "POST", body: JSON.stringify({ projectId, title, description, images, idempotencyKey: crypto.randomUUID() }) });
      window.location.assign(withCompany(`/tasks/${encodeURIComponent(result.id)}`, companyId));
    } catch (reason) { if (await reconcileScopedNotFound(reason, reloadCompanies)) return; setCreateError(reason instanceof Error ? reason.message : "Unable to create task"); }
    finally { setBusy(false); }
  };
  const startPlanning = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true); setError("");
    const optimistic: ApiTask = { ...selected, phase: "planning", revision: selected.revision + 1, owner: "lead", allowedCommands: [], pendingAction: "Lead planning" };
    selectedRef.current = optimistic; setSelected(optimistic); setTasks((current) => current.map((task) => task.id === optimistic.id ? optimistic : task));
    try { const updated = await readJson<ApiTask>(`/api/tasks/${selected.id}/start-planning`, { method: "POST", body: JSON.stringify({ expectedRevision: selected.revision }) }); selectedRef.current = updated; setSelected(updated); setTasks((current) => current.map((task) => task.id === updated.id ? updated : task)); await reload(); }
    catch (reason) { if (await reconcileScopedNotFound(reason, reloadCompanies)) return; await reload(); setError(reason instanceof Error ? reason.message : "Unable to start planning"); }
    finally { setBusy(false); }
  };
  const planAction = async (path: TaskPlanAction, note?: string): Promise<void> => {
    if (!selected) return;
    setBusy(true); setError("");
    try { const updated = await readJson<ApiTask>(`/api/tasks/${selected.id}/${path}`, { method: "POST", body: JSON.stringify({ expectedRevision: selected.revision, ...(note ? { note } : {}) }) }); selectedRef.current = updated; setSelected(updated); await reload(); }
    catch (reason) { if (await reconcileScopedNotFound(reason, reloadCompanies)) return; setError(reason instanceof Error ? reason.message : "Unable to update the plan"); }
    finally { setBusy(false); }
  };

  if (routeTaskId && loading) return <TaskDetailsSkeleton />;
  if (routeTaskId && !companyId) return <TaskDetailsNotFound companyId="" returnTo={mode} />;
  if (routeTaskId && !scopeLoaded && !error) return <TaskDetailsSkeleton />;
  if (routeTaskId && !scopeLoaded && error) return <ApplicationFrame title="Unable to load task"><div className="px-4 py-8 sm:px-6 lg:px-10"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div></ApplicationFrame>;
  if (routeTaskId && (!selected || detailNotFound)) return <TaskDetailsNotFound companyId={companyId} returnTo={mode} />;
  if (routeTaskId && selected) return <TaskDetailsPage task={selected} project={visibleProjects.find((project) => project.id === selected.projectId)} busy={busy} error={error} onStartPlanning={startPlanning} onPlanAction={planAction} />;

  if (mode === "board") {
    return (
      <ApplicationFrame title="Board" headerRight={<span className="text-[11px] text-muted-foreground">Read-only state</span>}>
        <div className="flex h-[calc(100vh-2.5rem)] min-h-0 flex-col border-t border-border/70 bg-background">
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/70 px-3 sm:px-4">
            <div className="flex items-center gap-2">
              <Select value={boardProjectId} onValueChange={(value) => setBoardProjectId(value ?? "all")}>
                <SelectTrigger aria-label="Filter board by project" className="h-7 w-auto min-w-28 rounded-full border-border bg-background px-2.5 text-xs shadow-none">
                  <SelectValue>{(value) => value === "all" ? "All projects" : visibleProjects.find((project) => project.id === value)?.name ?? "All projects"}</SelectValue>
                </SelectTrigger>
                <SelectContent><SelectItem value="all">All projects</SelectItem>{visibleProjects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent>
              </Select>
              <Layers3 className="size-3.5 text-muted-foreground" aria-hidden="true" />
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon-sm" aria-label="Filter board" title="Filter board"><Filter className="size-3.5" /></Button>
              <Button variant="outline" size="icon-sm" aria-label="Board display options" title="Board display options"><ListFilter className="size-3.5" /></Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-2">
            <Kanban value={taskBoard} onValueChange={() => {}} getItemValue={(task) => task.id} className="h-full">
              <KanbanBoard className="h-full min-w-max grid-flow-col auto-cols-[286px] grid-cols-none gap-2">
                {taskPhases.map((phase) => {
                  const statusClass = phase === "failed" || phase === "delivery_blocked" ? "text-rose-500" : phase === "delivery_reviewed" ? "text-indigo-500" : phase === "development" || phase === "delivery_ready" || phase === "reviewing_delivery" ? "text-amber-500" : phase === "backlog" || phase === "planning" ? "text-muted-foreground" : "text-blue-500";
                  const StatusIcon = phase === "delivery_reviewed" ? CheckCircle2 : phase === "failed" || phase === "delivery_blocked" ? CircleX : phase === "development" || phase === "delivery_ready" || phase === "reviewing_delivery" ? CircleDotDashed : CircleDashed;
                  return <KanbanColumn disabled key={phase} value={phase} className="min-h-0 rounded-md bg-muted/45">
                    <div className="flex h-10 shrink-0 items-center justify-between px-3 text-xs">
                      <div className="flex min-w-0 items-center gap-2"><StatusIcon className={`size-3.5 shrink-0 ${statusClass}`} /><span className="truncate font-medium">{taskPhaseLabel(phase)}</span><span className="text-muted-foreground">{taskBoard[phase].length}</span></div>
                      <div className="flex items-center gap-0.5 text-muted-foreground"><Button variant="ghost" size="icon-sm" className="size-6" aria-label={`${taskPhaseLabel(phase)} options`}><Ellipsis className="size-3.5" /></Button><Button render={<a href={withCompany("/tasks", companyId)} />} variant="ghost" size="icon-sm" className="size-6" aria-label="Create task"><Plus className="size-3.5" /></Button></div>
                    </div>
                    <KanbanColumnContent value={phase} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                      {taskBoard[phase].map((task) => {
                        const project = visibleProjects.find((candidate) => candidate.id === task.projectId);
                        return <button type="button" className="block w-full rounded-md border border-border/90 bg-card px-3 py-2.5 text-left text-xs transition-colors hover:border-muted-foreground/35 hover:bg-background focus-visible:outline-2 focus-visible:outline-ring" key={task.id} onClick={() => selectTask(task)}>
                          <span className="block font-medium leading-4 text-card-foreground">{task.title}</span>
                          {task.pendingAction ? <span className="mt-1 block truncate text-[11px] leading-4 text-muted-foreground">{task.pendingAction}</span> : null}
                          <span className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"><Layers3 className="size-3" />{project?.name ?? "Unknown project"}</span>
                        </button>;
                      })}
                    </KanbanColumnContent>
                  </KanbanColumn>;
                })}
              </KanbanBoard>
            </Kanban>
          </div>
          {detailNotFound ? <div className="border-t border-border/70 px-4 py-3 text-xs text-muted-foreground">Task not found for this company.</div> : null}
        </div>
      </ApplicationFrame>
    );
  }

  return (
    <ApplicationFrame title="Tasks">
      <div data-task-list className="min-h-[calc(100vh-2.5rem)] border-t border-border/70 bg-background text-foreground">
        <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border/70 px-3 py-1 sm:px-4">
          <Tabs value={taskFilter} onValueChange={(value) => setTaskFilter(value as TaskListFilter)}>
            <TabsList>
              <TabsTrigger value="active">Active <span className="text-[11px] text-muted-foreground">{activeCount}</span></TabsTrigger>
              <TabsTrigger value="backlog">Backlog <span className="text-[11px] text-muted-foreground">{backlogCount}</span></TabsTrigger>
              <TabsTrigger value="all">All tasks <span className="text-[11px] text-muted-foreground">{visibleTasks.length}</span></TabsTrigger>
            </TabsList>
          </Tabs>
          <a className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground" href={withCompany("/board", companyId)}>Open board</a>
        </div>
        {error ? <div className="p-3 sm:p-4"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
        {!scopeLoaded && !error ? <div className="space-y-px p-2" aria-label="Loading tasks" aria-busy="true"><Skeleton className="h-8 w-full" /><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /></div> : null}
        {scopeLoaded && taskGroups.length === 0 ? <div className="px-4 py-8 text-xs text-muted-foreground">{taskFilter === "active" ? "No active tasks." : taskFilter === "backlog" ? "No backlog tasks." : "No tasks yet. Press ⌘N to create one."}</div> : null}
        {scopeLoaded ? <div aria-label="Task groups">
          {taskGroups.map((group) => {
            const GroupIcon = group.id === "completed" ? CheckCircle2 : group.id === "blocked" ? CircleX : group.id === "active" ? CircleDotDashed : CircleDashed;
            const groupIconClass = group.id === "completed" ? "text-emerald-500" : group.id === "blocked" ? "text-rose-500" : group.id === "active" ? "text-amber-500" : "text-muted-foreground";
            return (
              <Collapsible.Root key={group.id} defaultOpen className="group/task-group border-b border-border/70">
                <Collapsible.Trigger className="flex h-8 w-full items-center gap-2 bg-muted/45 px-3 text-left text-xs outline-none transition-colors hover:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring/50 sm:px-4">
                  <ChevronRight className="size-3 text-muted-foreground transition-transform group-data-[open]/task-group:rotate-90" />
                  <GroupIcon className={`size-3.5 ${groupIconClass}`} />
                  <span className="font-medium">{group.title}</span>
                  <span className="text-muted-foreground">{group.tasks.length}</span>
                </Collapsible.Trigger>
                <Collapsible.Panel>
                  {group.tasks.map((task) => {
                    const project = visibleProjects.find((candidate) => candidate.id === task.projectId);
                    const appearance = taskPhaseAppearance(task.phase);
                    const StatusIcon = appearance.icon;
                    return (
                      <a data-task-row key={task.id} href={withCompany(`/tasks/${encodeURIComponent(task.id)}`, companyId)} className="group/task-row grid min-h-9 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-t border-border/55 px-3 text-[13px] outline-none transition-colors first:border-t-0 hover:bg-muted/40 focus-visible:bg-muted/50 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/50 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto] sm:px-4">
                        <StatusIcon className={`size-3.5 ${appearance.iconClass}`} />
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-medium">{task.title}</span>
                          {project ? <><ChevronRight className="hidden size-3 shrink-0 text-muted-foreground/60 md:block" /><span className="hidden truncate text-xs text-muted-foreground md:block">{project.name}</span></> : null}
                        </span>
                        <span className="hidden sm:inline-flex"><ReuiBadge variant={appearance.badge} size="sm" radius="full">{taskPhaseLabel(task.phase)}</ReuiBadge></span>
                        <time dateTime={task.updatedAt} className="w-16 text-right text-[11px] text-muted-foreground">{taskListDate(task.updatedAt)}</time>
                      </a>
                    );
                  })}
                </Collapsible.Panel>
              </Collapsible.Root>
            );
          })}
        </div> : null}
        {!currentCompany && scopeLoaded ? <div className="px-4 py-8 text-xs text-muted-foreground">{loading ? "Loading companies" : companyError ? "Unable to load companies" : user?.role === "admin" ? "Create a company to begin." : "No company access. Ask an administrator to assign a company."}</div> : null}
        <NewTaskDialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (open) setCreateError(""); }} companyName={currentCompany?.name} companyStatus={currentCompany?.status} projects={availableProjects} projectId={projectId} onProjectChange={setProjectId} title={title} onTitleChange={setTitle} description={description} onDescriptionChange={setDescription} images={images} onAddImages={addImages} onRemoveImage={(index) => setImages((current) => current.filter((_, candidate) => candidate !== index))} busy={busy} error={createError} onSubmit={create} />
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
      <div>
        <div className="flex h-9 items-center justify-between px-3 text-xs sm:px-4"><span className="font-medium">Agency attention</span><Button variant="ghost" size="sm" onClick={() => void reload()}>Refresh</Button></div>
        {companies.map((company) => <section className="bg-background p-3 sm:p-4" key={company.companyId}>
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2"><div className="flex items-center gap-2 text-[13px] font-medium"><span className={company.attentionCount ? "size-1.5 rounded-full bg-amber-500" : "size-1.5 rounded-full bg-emerald-500"} />{company.companyName}</div><div className="text-[11px] text-muted-foreground">{company.activeIssueCount} active · {company.attentionCount} needs a person</div></div>
          <Accordion className="text-xs" multiple>{company.attention.map((item) => <AccordionItem className="py-1" key={item.id} value={item.id}><AccordionTrigger className="py-3"><span className="min-w-0 text-left"><Badge variant="secondary" className="mr-2 align-middle text-[10px]">{item.category.replaceAll("_", " ")}</Badge><span className="font-medium">{item.taskTitle}</span><span className="mt-1 block text-muted-foreground">{item.summary}</span></span></AccordionTrigger><AccordionContent className="grid gap-2 pl-3 text-[11px] text-muted-foreground sm:grid-cols-[1fr_auto] sm:items-center"><span>{item.action}{item.evidenceRef ? ` · Evidence ${item.evidenceRef}` : ""}</span><a className="text-foreground underline underline-offset-2" href={withCompany(`/tasks/${encodeURIComponent(item.taskId)}`, item.companyId)}>Open issue</a></AccordionContent></AccordionItem>)}</Accordion>
          {company.attention.length === 0 ? <div className="py-5 text-center text-xs text-muted-foreground">No decision needed.</div> : null}
          {company.recentOutcomes.length ? <div className="mt-3 pt-2 text-[11px] text-muted-foreground">Recent: {company.recentOutcomes.map((outcome) => `${outcome.taskTitle} · ${outcome.phase}`).join(" · ")}</div> : null}
        </section>)}
        {companies.length === 0 && !error ? <div className="p-8 text-center text-xs text-muted-foreground">No companies visible.</div> : null}
        {error ? <Alert variant="destructive" className="mx-4 my-3"><AlertDescription>{error}</AlertDescription></Alert> : null}
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
    return <ApplicationFrame title="Company settings"><div className="space-y-2 p-4" aria-busy="true" aria-label="Loading company settings"><Skeleton className="h-4 w-40" /><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-3/4" /></div></ApplicationFrame>;
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

  const backHref = withCompany("/projects", company.id);

  return (
    <SettingsLayout title="Workspace" companyId={company.id} backHref={backHref} activeHref={companySettingsPath(company.id)}>
      <SettingsSection title="Profile">
        <SettingRow label="Company name" description="Public workspace name.">
          <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <Input id="company-name" value={name} onChange={(event) => { setName(event.target.value); setSaved(false); }} />
            <Button type="submit" size="sm" disabled={busy !== "" || !name.trim() || name.trim() === company.name}><Save className="size-3.5" />{busy === "rename" ? "Saving…" : saved ? "Saved" : "Save"}</Button>
          </form>
        </SettingRow>
        <SettingRow label="Company ID" description="Unique identifier.">
          <code className="select-all text-xs text-muted-foreground">{company.id}</code>
        </SettingRow>
        <SettingRow label="Created" description={new Date(company.createdAt).toLocaleDateString()}>
          <span className="text-xs text-muted-foreground">{new Date(company.createdAt).toLocaleDateString()}</span>
        </SettingRow>
      </SettingsSection>
      {error ? <Alert variant="destructive" className="mb-4 text-xs text-rose-700"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <SettingsSection title="Lifecycle" description="Control workspace activity.">
        {company.status === "active" ? <SettingRow label="Pause company" description="Existing records remain available; new projects and tasks are blocked."><Button variant="outline" size="sm" onClick={() => void mutateStatus("paused")} disabled={busy !== ""}><Pause className="size-3.5" />{busy === "paused" ? "Pausing…" : "Pause company"}</Button></SettingRow> : null}
        {company.status === "paused" ? <SettingRow label="Reactivate company" description="Restore creation of new projects and tasks."><Button size="sm" onClick={() => void mutateStatus("active")} disabled={busy !== ""}><RotateCcw className="size-3.5" />{busy === "active" ? "Reactivating…" : "Reactivate company"}</Button></SettingRow> : null}
        {company.status !== "archived" ? <SettingRow label="Archive company" description="Archive is reversible, retains history, and blocks new work." destructive><Button variant="outline" size="sm" className="text-rose-700" onClick={() => setArchiveOpen(true)} disabled={busy !== ""}><Archive className="size-3.5" />Archive company</Button></SettingRow> : null}
        {company.status === "archived" ? <SettingRow label="Restore company" description="Restore the company to active status."><Button size="sm" onClick={() => void mutateStatus("active")} disabled={busy !== ""}><RotateCcw className="size-3.5" />{busy === "active" ? "Restoring…" : "Restore company"}</Button></SettingRow> : null}
      </SettingsSection>
      <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Archive {company.name}?</AlertDialogTitle><AlertDialogDescription>This is reversible. Project and task history remains readable, but new work is blocked.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void mutateStatus("archived")} disabled={busy !== ""}>{busy === "archived" ? "Archiving…" : "Archive"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </SettingsLayout>
  );
}

function StatusIndicator({ check }: { check: HealthCheck }): ReactElement {
  const healthy = check.status === "healthy";
  const degraded = !healthy && !isOwnedHealthCheck(check.id);
  return (
    <span className={healthy ? "flex items-center gap-1.5 text-xs text-emerald-700" : degraded ? "flex items-center gap-1.5 text-xs text-amber-700" : "flex items-center gap-1.5 text-xs text-rose-700"}>
      <span className={healthy ? "size-1.5 rounded-full bg-emerald-500" : degraded ? "size-1.5 rounded-full bg-amber-500" : "size-1.5 rounded-full bg-rose-500"} />
      {healthy ? "Healthy" : degraded ? "Degraded" : "Unavailable"}
    </span>
  );
}

function HealthRow({ check }: { check: HealthCheck }): ReactElement {
  const Icon = icons[check.id] ?? CircleHelp;
  return (
    <Collapsible.Root data-slot="health-row" data-status={check.status} className="group">
      <Collapsible.Trigger className="flex min-h-9 w-full items-center gap-2.5 px-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring/50 sm:px-4">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{check.label}</span>
        <span className="hidden min-w-0 flex-1 truncate pl-2 text-xs text-muted-foreground sm:block">{check.summary}</span>
        <StatusIndicator check={check} />
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="bg-muted/20 px-9 py-2.5 sm:px-11">
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
  const [freshness, setFreshness] = useState<"checking" | "current" | "stale">("current");
  const [lastSuccessfulCheckAt, setLastSuccessfulCheckAt] = useState(initialSnapshot.generatedAt);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    setFreshness("checking");
    try {
      const response = await fetch("/api/health", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("Health request failed");
      const nextSnapshot = await response.json() as HealthSnapshot;
      setSnapshot(nextSnapshot);
      setLastSuccessfulCheckAt(nextSnapshot.generatedAt);
      setFreshness("current");
    } catch {
      // Retain the last successful snapshot, but never present it as current.
      setFreshness("stale");
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
  const freshnessLabel = freshness === "checking"
    ? "Checking health…"
    : freshness === "stale"
      ? `Refresh failed · Last successful check ${relativeTime(lastSuccessfulCheckAt)}`
      : `Last successful check ${relativeTime(lastSuccessfulCheckAt)}`;
  const compactFreshnessLabel = freshness === "checking"
    ? "Checking…"
    : freshness === "stale"
      ? `Stale · ${relativeTime(lastSuccessfulCheckAt)}`
      : `Checked ${relativeTime(lastSuccessfulCheckAt)}`;

  return (
    <ApplicationFrame title="Host health" headerRight={
      <div className="flex items-center gap-2">
        <span className={snapshot.ready ? "hidden items-center gap-1.5 text-xs text-emerald-700 sm:flex" : "hidden items-center gap-1.5 text-xs text-amber-700 sm:flex"}>
          <span className={snapshot.ready ? "size-1.5 rounded-full bg-emerald-500" : "size-1.5 rounded-full bg-amber-500"} />
          {snapshot.ready ? "Ready" : "Needs attention"}
        </span>
        <a className="max-w-[34vw] truncate text-[11px] text-muted-foreground hover:text-foreground sm:max-w-64 sm:text-xs" href={snapshot.reachableAddress}>{snapshot.reachableAddress.replace(/^https?:\/\//, "")}</a>
        <span aria-live="polite" data-health-freshness={freshness} title={freshnessLabel} className={freshness === "stale" ? "max-w-[20vw] truncate text-[11px] text-amber-700 sm:hidden" : "max-w-[20vw] truncate text-[11px] text-muted-foreground sm:hidden"}>{compactFreshnessLabel}</span>
        <span aria-live="polite" data-health-freshness={freshness} className={freshness === "stale" ? "hidden text-[11px] text-amber-700 md:inline" : "hidden text-[11px] text-muted-foreground md:inline"}>{freshnessLabel}</span>
        <Button aria-label="Refresh health" title="Refresh health" variant="ghost" size="icon" onClick={() => void refresh()} disabled={refreshing}><RefreshCw className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} /></Button>
      </div>
    }>

          <div className="flex h-9 items-center justify-between bg-muted/20 px-3 sm:px-4">
            <div className="flex h-full items-center gap-4 text-xs">
              <span className="flex h-full items-center font-medium text-foreground">Health</span>
              <span className="text-muted-foreground">{snapshot.checks.length} checks</span>
              <span className="text-emerald-700">{healthyCount} healthy</span>
              <span className={failingCount > 0 ? "text-rose-700" : "text-muted-foreground"}>{failingCount} issues</span>
            </div>
            <span aria-live="polite" data-health-freshness={freshness} className={freshness === "stale" ? "hidden items-center gap-1.5 text-[11px] text-amber-700 sm:flex" : "hidden items-center gap-1.5 text-[11px] text-muted-foreground sm:flex"}><Clock3 className="size-3" />{freshnessLabel}</span>
          </div>

          <div>
            <section aria-labelledby="owned-services">
              <div className="flex h-8 items-center justify-between px-3 sm:px-4">
                <h2 id="owned-services" className="text-[11px] font-semibold text-muted-foreground">Owned services</h2>
                <span className="text-[11px] text-muted-foreground">{ownedChecks.length}</span>
              </div>
              <div>{ownedChecks.map((check) => <HealthRow check={check} key={check.id} />)}</div>
            </section>
            <section aria-labelledby="provider-access" className="mt-5">
              <div className="flex h-8 items-center justify-between px-3 sm:px-4">
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
const authenticatedView = view === "admin" ? <AdminView /> : view === "projects" ? <ProjectsView /> : view === "tasks" ? <TasksView /> : view === "board" ? <TasksView mode="board" /> : view === "attention" ? <AttentionView /> : view === "company-settings" ? <CompanySettingsView /> : <Dashboard initialSnapshot={window.__FORGE_HEALTH__} />;
createRoot(document.getElementById("forge-app")!).render(view === "auth" ? <AuthView /> : <CompanyProvider>{authenticatedView}</CompanyProvider>);
