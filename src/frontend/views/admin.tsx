import { Alert, AlertDescription } from ".././components/ui/alert.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from ".././components/ui/alert-dialog.js";
import { Badge } from ".././components/ui/badge.js";
import { Button } from ".././components/ui/button.js";
import { Checkbox } from ".././components/ui/checkbox.js";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from ".././components/ui/dialog.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from ".././components/ui/dropdown-menu.js";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from ".././components/ui/field.js";
import { Input } from ".././components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from ".././components/ui/select.js";
import { Skeleton } from ".././components/ui/skeleton.js";
import { useCompanyContext } from ".././components/app/company-context.js";
import { SettingsLayout } from ".././components/app/settings-layout.js";
import { SettingsDataTable, SettingsTableCell, SettingsTableEmpty, SettingsTableGroup, SettingsTableRow, SettingsToolbar, SettingsToolbarAction, type SettingsTableColumn } from ".././components/app/settings-table.js";
import { ProfileAvatar } from ".././components/app/profile-avatar.js";
import { readJson, withCompany, type ApiUser } from ".././lib/api.js";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { adminDate, type ApiAgent, type ApiCredential, type ApiHermesAgent, type ApiInvitation, type ApiModel, type ApiProfile, type ApiProject } from "../lib/view-shared.js";
import { Archive, ArchiveRestore, Check, Copy, Ellipsis, Key, Pencil, RotateCw, Save, ShieldAlert } from "lucide-react";

import { PromptSettings } from "./prompt-settings.js";
const USER_COLUMNS: SettingsTableColumn[] = [
  { key: "name", label: "Name ↓", width: 177 },
  { key: "username", label: "Username", width: 118 },
  { key: "role", label: "Role", width: 140 },
  { key: "companies", label: "Companies", width: 82 },
  { key: "passkeys", label: "Passkeys", width: 82 },
  { key: "status", label: "Status", width: 82 },
  { key: "menu", width: 28 },
  { key: "end", width: 32 },
];

const PROFILE_COLUMNS: SettingsTableColumn[] = [
  { key: "name", label: "Name ↓", width: 240 },
  { key: "provider", label: "Provider", width: 110 },
  { key: "model", label: "Model", width: 200 },
  { key: "reasoning", label: "Reasoning", width: 75 },
  { key: "priority", label: "Priority", width: 102 },
  { key: "capacity", label: "Capacity", width: 102 },
  { key: "save", width: 28 },
  { key: "end", width: 32 },
];

const AGENT_COLUMNS: SettingsTableColumn[] = [
  { key: "name", label: "Name ↓", width: 240 },
  { key: "role", label: "Role", width: 140 },
  { key: "profile", label: "Profile", width: 220 },
  { key: "status", label: "Status", width: 100 },
  { key: "menu", width: 28 },
  { key: "end", width: 32 },
];

const HERMES_AGENT_COLUMNS: SettingsTableColumn[] = [
  { key: "name", label: "Name ↓", width: 200 },
  { key: "status", label: "Status", width: 280 },
  { key: "projects", label: "Projects", width: 180 },
  { key: "credentialCreatedAt", label: "Credential created", width: 140 },
  { key: "lastUsed", label: "Last used", width: 140 },
  { key: "menu", width: 28 },
  { key: "end", width: 32 },
];

const COMPANY_COLUMNS: SettingsTableColumn[] = [
  { key: "name", label: "Name ↓", width: 220 },
  { key: "issueCode", label: "Issue code", width: 120 },
  { key: "status", label: "Status", width: 110 },
  { key: "created", label: "Created", width: 170 },
  { key: "menu", width: 28 },
  { key: "end", width: 32 },
];

const INVITATION_COLUMNS: SettingsTableColumn[] = [
  { key: "invitee", label: "Invitee / token", width: 220 },
  { key: "role", label: "Role", width: 100 },
  { key: "company", label: "Company", width: 140 },
  { key: "expires", label: "Expires", width: 170 },
  { key: "status", label: "Status", width: 100 },
];

const PASSKEY_COLUMNS: SettingsTableColumn[] = [
  { key: "label", label: "Name / label", width: 200 },
  { key: "owner", label: "Owner", width: 160 },
  { key: "created", label: "Created", width: 160 },
  { key: "lastUsed", label: "Last used", width: 160 },
  { key: "status", label: "Status", width: 100 },
  { key: "menu", width: 28 },
  { key: "end", width: 32 },
];

const MODEL_COLUMNS: SettingsTableColumn[] = [
  { key: "model", label: "Model ↓", width: 220 },
  { key: "provider", label: "Provider", width: 110 },
  { key: "displayName", label: "Display name", width: 200 },
  { key: "status", label: "Status", width: 100 },
  { key: "sort", label: "Sort", width: 64 },
  { key: "menu", width: 28 },
  { key: "end", width: 32 },
];

const USER_GROUPS: Array<{ label: string; status: ApiUser["status"] }> = [
  { label: "Active", status: "active" },
  { label: "Pending", status: "pending" },
  { label: "Revoked", status: "revoked" },
];

function AgentNameEditor({ agent, onSave }: { agent: ApiAgent; onSave: (name: string) => Promise<void> }): ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(agent.name);
  const [saving, setSaving] = useState(false);
  const skipBlur = useRef(false);
  useEffect(() => { if (!editing) setDraft(agent.name); }, [editing, agent.name]);
  const save = async (): Promise<void> => {
    if (skipBlur.current) { skipBlur.current = false; return; }
    const next = draft.trim();
    if (next === agent.name) { setEditing(false); return; }
    if (!next || saving) return;
    setSaving(true);
    try { await onSave(next); setEditing(false); } finally { setSaving(false); }
  };
  if (editing) {
    return <Input aria-label={`Agent name`} autoFocus className="h-7" disabled={saving} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => void save()} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); skipBlur.current = true; setDraft(agent.name); setEditing(false); } else if (event.key === "Enter") event.currentTarget.blur(); }} />;
  }
  return <button type="button" data-agent-name-editor aria-label={`Rename ${agent.name}`} className="min-w-0 truncate text-left" onClick={() => { skipBlur.current = false; setDraft(agent.name); setEditing(true); }}>{agent.name}</button>;
}

export function AdminView(): ReactElement {
  const { user, companies, currentCompany, loading } = useCompanyContext();
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [invitations, setInvitations] = useState<ApiInvitation[]>([]);
  const [credentials, setCredentials] = useState<ApiCredential[]>([]);
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const [hermesAgents, setHermesAgents] = useState<ApiHermesAgent[]>([]);
  const [companyProjects, setCompanyProjects] = useState<ApiProject[]>([]);
  const [models, setModels] = useState<ApiModel[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profileModel, setProfileModel] = useState("gpt-5.6-sol");
  const [profileProvider, setProfileProvider] = useState<"codex" | "claude">("codex");
  const [profileReasoning, setProfileReasoning] = useState("medium");
  const [profilePriority, setProfilePriority] = useState("standard");
  const [profileCapacity, setProfileCapacity] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("");
  const [agentRole, setAgentRole] = useState<"planner" | "builder" | "reviewer" | "integrator">("planner");
  const [agentAvatarSeed, setAgentAvatarSeed] = useState("");
  const [agentProfileId, setAgentProfileId] = useState("");
  const [agentOpen, setAgentOpen] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<ApiAgent | null>(null);
  const [capacityLanes, setCapacityLanes] = useState<Array<{ profileId: string; activeCount: number; queuedCount: number }>>([]);
  const [capacityEdits, setCapacityEdits] = useState<Record<string, string>>({});
  const [modelId, setModelId] = useState("");
  const [modelName, setModelName] = useState("");
  const [modelProvider] = useState<"codex" | "claude">("codex");
  const [modelOpen, setModelOpen] = useState(false);
  const [inviteToken, setInviteToken] = useState("");
  const [inviteExpiresAt, setInviteExpiresAt] = useState("");
  const [copied, setCopied] = useState(false);
  const [pendingAction, setPendingAction] = useState("");
  const [error, setError] = useState("");

  // Hermes agent administration state
  const [newHermesOpen, setNewHermesOpen] = useState(false);
  const [hermesName, setHermesName] = useState("");
  const [hermesError, setHermesError] = useState("");
  const [hermesProjectIds, setHermesProjectIds] = useState<string[]>([]);
  const [hermesAvatarSeed, setHermesAvatarSeed] = useState("");
  const [pairingCodeModalOpen, setPairingCodeModalOpen] = useState(false);
  const [pairingCodeData, setPairingCodeData] = useState<{ code: string; expiresAt: string; agentName: string } | null>(null);
  const [hermesProfileName, setHermesProfileName] = useState("default");
  const [pairingCodeCopied, setPairingCodeCopied] = useState(false);
  const [pairingInstructionsCopied, setPairingInstructionsCopied] = useState(false);
  const [editProjectsModalOpen, setEditProjectsModalOpen] = useState(false);
  const [editingHermesAgent, setEditingHermesAgent] = useState<ApiHermesAgent | null>(null);
  const [editingHermesProjectIds, setEditingHermesProjectIds] = useState<string[]>([]);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [userList, invitationList, credentialList, profileList, agentList, hermesList, projectList, modelList, laneList] = await Promise.all([
        readJson<{ users: ApiUser[] }>("/api/admin/users"),
        readJson<{ invitations: ApiInvitation[] }>("/api/admin/invitations"),
        readJson<{ credentials: ApiCredential[] }>("/api/admin/credentials"),
        readJson<{ profiles: ApiProfile[] }>("/api/profiles").catch(() => ({ profiles: [] })),
        readJson<{ agents: ApiAgent[] }>("/api/agents?includeArchived=true").catch(() => ({ agents: [] })),
        readJson<{ agents: ApiHermesAgent[] }>(`/api/admin/hermes-agents${currentCompany ? `?companyId=${encodeURIComponent(currentCompany.id)}` : ""}`).catch(() => ({ agents: [] })),
        currentCompany ? readJson<{ projects: ApiProject[] }>(`/api/companies/${encodeURIComponent(currentCompany.id)}/projects`).catch(() => ({ projects: [] })) : Promise.resolve({ projects: [] }),
        readJson<{ models: ApiModel[] }>("/api/admin/models").catch(() => ({ models: [] })),
        readJson<{ lanes: Array<{ profileId: string; activeCount: number; queuedCount: number }> }>("/api/admin/capacity").catch(() => ({ lanes: [] })),
      ]);
      setUsers(userList.users);
      setInvitations(invitationList.invitations);
      setCredentials(credentialList.credentials);
      setProfiles(profileList.profiles);
      setAgents(agentList.agents);
      setHermesAgents(hermesList.agents);
      setCompanyProjects(projectList.projects);
      const projectIds = new Set(projectList.projects.map((project) => project.id));
      setHermesProjectIds((selected) => selected.filter((projectId) => projectIds.has(projectId)));
      setEditingHermesProjectIds((selected) => selected.filter((projectId) => projectIds.has(projectId)));
      setModels(modelList.models);
      setCapacityLanes(laneList.lanes);
      const activeModels = modelList.models.filter((model) => model.status === "active");
      setProfileModel((current) => activeModels.some((model) => model.id === current) ? current : activeModels[0]?.id ?? "");
    } catch (reason) {
      if (reason instanceof Error && reason.message === "Authentication required") window.location.assign("/auth");
      else setError("Unable to load administration");
    }
  }, [currentCompany]);

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
  const openNewProfile = (): void => {
    setEditingProfileId(null); setProfileName(""); setProfileProvider("codex"); setProfileModel("gpt-5.6-sol"); setProfileReasoning("medium"); setProfilePriority("standard"); setProfileCapacity(""); setProfileOpen(true);
  };
  const openEditProfile = (profile: ApiProfile): void => {
    setEditingProfileId(profile.id); setProfileName(profile.name); setProfileProvider(profile.provider); setProfileModel(profile.model); setProfileReasoning(profile.reasoningLevel); setProfilePriority(profile.servicePriority); setProfileCapacity(profile.capacity === null ? "" : String(profile.capacity)); setProfileOpen(true);
  };
  const saveProfile = async (): Promise<void> => {
    const editing = editingProfileId !== null;
    try {
      await readJson(editing ? `/api/admin/profiles/${encodeURIComponent(editingProfileId)}` : "/api/admin/profiles", { method: editing ? "PATCH" : "POST", body: JSON.stringify({ name: profileName, provider: profileProvider, model: profileModel, reasoningLevel: profileReasoning, servicePriority: profilePriority, capacity: profileCapacity.trim() === "" ? null : Number(profileCapacity) }) });
      setProfileName(""); setProfileCapacity(""); setEditingProfileId(null); setProfileOpen(false); await reload();
    } catch { setError(editing ? "Unable to update profile" : "Unable to create profile"); }
  };
  const openNewAgent = (): void => { setEditingAgentId(null); setAgentName(""); setAgentRole("planner"); setAgentAvatarSeed(crypto.randomUUID().replaceAll("-", "")); setAgentProfileId(profiles[0]?.id ?? ""); setAgentOpen(true); };
  const openEditAgent = (agent: ApiAgent): void => { setEditingAgentId(agent.id); setAgentName(agent.name); setAgentRole(agent.role); setAgentAvatarSeed(agent.avatarSeed); setAgentProfileId(agent.profileId); setAgentOpen(true); };
  const saveAgent = async (): Promise<void> => {
    const editing = editingAgentId !== null;
    try {
      await readJson(editing ? `/api/admin/agents/${encodeURIComponent(editingAgentId)}` : "/api/admin/agents", { method: editing ? "PATCH" : "POST", body: JSON.stringify({ name: agentName, role: agentRole, avatarSeed: agentAvatarSeed, profileId: agentProfileId }) });
      setAgentOpen(false); setEditingAgentId(null); await reload();
    } catch { setError(editing ? "Unable to update agent" : "Unable to create agent"); }
  };
  const patchAgent = async (agent: ApiAgent, body: Record<string, unknown>, fallback: string): Promise<void> => {
    try {
      await readJson(`/api/admin/agents/${encodeURIComponent(agent.id)}`, { method: "PATCH", body: JSON.stringify(body) });
      setError("");
      await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : fallback); }
  };
  const duplicateAgent = async (agent: ApiAgent): Promise<void> => {
    try {
      await readJson(`/api/admin/agents/${encodeURIComponent(agent.id)}/duplicate`, { method: "POST", body: "{}" });
      setError("");
      await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to duplicate agent"); }
  };

  // Hermes handlers
  const openNewHermesAgent = (): void => {
    setHermesName("");
    setHermesError("");
    setHermesProjectIds([]);
    setHermesAvatarSeed(crypto.randomUUID().replaceAll("-", ""));
    setNewHermesOpen(true);
  };

  const createHermesAgent = async (): Promise<void> => {
    if (!currentCompany) return;
    setHermesError("");
    try {
      const result = await readJson<{ agent: ApiHermesAgent; pairingCode: string; expiresAt: string }>("/api/admin/hermes-agents", {
        method: "POST",
        body: JSON.stringify({
          name: hermesName.trim(),
          companyId: currentCompany.id,
          projectIds: hermesProjectIds,
          avatarSeed: hermesAvatarSeed,
        }),
      });
      setNewHermesOpen(false);
      setPairingCodeData({ code: result.pairingCode, expiresAt: result.expiresAt, agentName: result.agent.name });
      setHermesProfileName("default");
      setPairingCodeCopied(false);
      setPairingInstructionsCopied(false);
      setPairingCodeModalOpen(true);
      await reload();
    } catch (error) {
      setHermesError(error instanceof Error ? error.message : "Unable to create Hermes agent");
    }
  };

  const reissueHermesPairing = async (agent: ApiHermesAgent): Promise<void> => {
    try {
      const result = await readJson<{ pairingCode: string; expiresAt: string }>(`/api/admin/hermes-agents/${encodeURIComponent(agent.id)}/pairing-code`, {
        method: "POST",
        body: "{}",
      });
      setPairingCodeData({ code: result.pairingCode, expiresAt: result.expiresAt, agentName: agent.name });
      setHermesProfileName("default");
      setPairingCodeCopied(false);
      setPairingInstructionsCopied(false);
      setPairingCodeModalOpen(true);
      await reload();
    } catch {
      setError("Unable to reissue pairing code");
    }
  };

  const rotateHermesAgent = async (agent: ApiHermesAgent): Promise<void> => {
    try {
      const result = await readJson<{ pairingCode: string; expiresAt: string }>(`/api/admin/hermes-agents/${encodeURIComponent(agent.id)}/rotate`, {
        method: "POST",
        body: "{}",
      });
      setPairingCodeData({ code: result.pairingCode, expiresAt: result.expiresAt, agentName: agent.name });
      setHermesProfileName("default");
      setPairingCodeCopied(false);
      setPairingInstructionsCopied(false);
      setPairingCodeModalOpen(true);
      await reload();
    } catch {
      setError("Unable to rotate Hermes agent");
    }
  };

  const revokeHermesAgent = async (agent: ApiHermesAgent): Promise<void> => {
    const action = `hermes:revoke:${agent.id}`;
    if (pendingAction !== action) {
      setPendingAction(action);
      return;
    }
    try {
      await readJson(`/api/admin/hermes-agents/${encodeURIComponent(agent.id)}/revoke`, {
        method: "POST",
        body: "{}",
      });
      setPendingAction("");
      await reload();
    } catch {
      setError("Unable to revoke Hermes agent");
    }
  };

  const openEditHermesProjects = (agent: ApiHermesAgent): void => {
    setEditingHermesAgent(agent);
    setEditingHermesProjectIds([...agent.projectIds]);
    setEditProjectsModalOpen(true);
  };

  const saveHermesProjects = async (): Promise<void> => {
    if (!editingHermesAgent) return;
    try {
      await readJson<{ agent: ApiHermesAgent }>(`/api/admin/hermes-agents/${encodeURIComponent(editingHermesAgent.id)}/projects`, {
        method: "PUT",
        body: JSON.stringify({ projectIds: editingHermesProjectIds }),
      });
      setEditProjectsModalOpen(false);
      setEditingHermesAgent(null);
      await reload();
    } catch {
      setError("Unable to update agent projects");
    }
  };

  const copyPairingCode = async (): Promise<void> => {
    if (!pairingCodeData?.code) return;
    try {
      await navigator.clipboard.writeText(pairingCodeData.code);
      setPairingCodeCopied(true);
    } catch {
      setError("Unable to copy pairing code");
    }
  };

  const hermesSetupInstructions = (): string => {
    if (!pairingCodeData?.code || !pairingCodeData.expiresAt) return "";
    const baseUrl = window.location.origin;
    const profileId = hermesProfileName.trim() || "default";
    const instructions = [
      "# Connect this Hermes profile to Forge",
      "",
      "Configure only the active Hermes profile.",
      "",
      "- Forge base URL: `" + baseUrl + "`",
      "- One-time pairing code: `" + pairingCodeData.code + "`",
      "- Pairing code expires: `" + adminDate(pairingCodeData.expiresAt) + "`",
      "",
      "Complete these steps:",
      "",
      "1. Pair the Hermes profile `" + profileId + "`.",
      "",
      "2. Exchange the pairing code by sending JSON to `POST " + baseUrl + "/api/hermes/pairing/exchange`:",
      "",
      "   ```json",
      "   {",
      "     \"pairingCode\": \"" + pairingCodeData.code + "\",",
      "     \"profileId\": \"" + profileId + "\"",
      "   }",
      "   ```",
      "",
      "3. Capture the exchange response without printing the raw response or credential. Preserve the active profile's existing `$HERMES_HOME/.env` contents and set:",
      "",
      "   - `FORGE_BASE_URL=" + baseUrl + "`",
      "   - `FORGE_AGENT_CREDENTIAL=<returned credential>`",
      "",
      "   Replace existing values for those keys instead of creating duplicates. Keep the file profile-local and restricted to the current user. Never put the credential in chat output, memory, logs, shell history, skill markdown, or source control.",
      "",
      "4. Create or update a profile-local Forge skill at `$HERMES_HOME/skills/forge/`. Use the Python standard library and read the Forge URL and credential from the environment at runtime. The skill must support:",
      "",
      "   - Creating a task with `POST /api/hermes/tasks` and JSON fields `projectId`, `title`, `description`, and `idempotencyKey`.",
      "   - Retrieving status with `GET /api/hermes/tasks/{taskId}`.",
      "   - Sending `Authorization: Bearer <credential>` on every Forge machine request.",
      "   - Generating one idempotency key per requested task, reusing it for retries of the same payload, and never reusing it for a different payload.",
      "   - Requiring an explicit project ID and treating Forge's persisted project grants as authoritative.",
      "",
      "5. Create one persistent connectivity acknowledgment task by sending `POST " + baseUrl + "/api/hermes/tasks` with the stored bearer credential. Build the request from the exchange response:",
      "",
      "   - `projectId`: the first value in the returned `agent.projectIds` array.",
      "   - `title`: `Hermes connectivity confirmed`.",
      "   - `description`: `Connection acknowledged. Do not plan or execute this task.`",
      "   - `idempotencyKey`: `forge-connectivity-` followed by the returned `agent.id`.",
      "",
      "   Reuse that exact request if retrying. A `200` or `201` response confirms connectivity. The task must remain in `backlog` with `Start planning` pending; do not invoke any task command. If no allowed project ID was returned, do not create the task and report that project access is required.",
      "",
      "6. Report only the pairing result, Forge agent name/ID, active profile ID, allowed project IDs, and the acknowledgment task issue key/ID and phase. Never echo the pairing code or bearer credential.",
    ].join("\n");
    return instructions;
  };
  const copyHermesSetupInstructions = async (): Promise<void> => {
    const instructions = hermesSetupInstructions();
    if (!instructions) return;
    try {
      await navigator.clipboard.writeText(instructions);
      setPairingInstructionsCopied(true);
    } catch {
      setPairingInstructionsCopied(false);
      setError("Unable to copy Hermes setup instructions");
    }
  };

  const updateCapacity = async (profile: ApiProfile): Promise<void> => {
    const raw = capacityEdits[profile.id] ?? (profile.capacity === null ? "" : String(profile.capacity));
    try { await readJson(`/api/admin/profiles/${encodeURIComponent(profile.id)}/capacity`, { method: "PATCH", body: JSON.stringify({ capacity: raw.trim() === "" ? null : Number(raw) }) }); await reload(); } catch { setError("Unable to update capacity"); }
  };
  const createModel = async (): Promise<void> => {
    try {
      await readJson("/api/admin/models", { method: "POST", body: JSON.stringify({ id: modelId, provider: modelProvider, displayName: modelName, description: "", sortOrder: 100 }) });
      setModelId(""); setModelName(""); setModelOpen(false); await reload();
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

  const isProfiles = window.location.pathname.endsWith("/profiles");
  const isAgents = window.location.pathname.endsWith("/agents");
  const sortedAgents = [...agents].sort((left, right) => Number(Boolean(left.archivedAt)) - Number(Boolean(right.archivedAt)));
  const isModels = window.location.pathname.endsWith("/models");
  const isCompanies = window.location.pathname.endsWith("/companies");
  const isInvitations = window.location.pathname.endsWith("/invitations");
  const isPasskeys = window.location.pathname.endsWith("/passkeys");
  const isPrompts = window.location.pathname.endsWith("/prompts");
  const viewTitle = isPrompts ? "Prompts" : isProfiles ? "Profiles" : isAgents ? "Agents" : isModels ? "Models" : isCompanies ? "Companies" : isInvitations ? "Invitations" : isPasskeys ? "Passkeys" : "Users";
  const activeHref = withCompany(window.location.pathname, currentCompany?.id);
  const backHref = withCompany("/projects", currentCompany?.id);
  if (isPrompts) return <PromptSettings scope="global" />;

  if (loading) {
    return (
      <SettingsLayout title={viewTitle} companyId={currentCompany?.id ?? ""} backHref={backHref} activeHref={activeHref} contentClassName="">
        <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading administration"><Skeleton className="h-4 w-40" /><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-3/4" /></div>
      </SettingsLayout>
    );
  }
  if (user?.role !== "admin") {
    return (
      <SettingsLayout title={viewTitle} companyId={currentCompany?.id ?? ""} backHref={backHref} activeHref={activeHref} contentClassName="">
        <div className="p-4 text-xs text-muted-foreground">Administration is unavailable.</div>
      </SettingsLayout>
    );
  }

  return (
    <SettingsLayout title={viewTitle} companyId={currentCompany?.id ?? ""} backHref={backHref} activeHref={activeHref} contentClassName="">
      <div>
        {!isProfiles && !isAgents && !isModels && !isCompanies && !isInvitations && !isPasskeys ? (
          <section>
            <SettingsToolbar searchLabel="Search users" searchPlaceholder="Search by name or username" filterLabel="All" actions={<SettingsToolbarAction disabled>Export CSV</SettingsToolbarAction>} />
            <SettingsDataTable label="Users" columns={USER_COLUMNS} className="mt-5">
              {USER_GROUPS.map((group) => {
                const groupUsers = users.filter((candidate) => candidate.status === group.status);
                if (groupUsers.length === 0) return null;
                return (
                  <SettingsTableGroup columnCount={USER_COLUMNS.length} count={groupUsers.length} key={group.status} label={group.label}>
                    {groupUsers.map((candidate) => {
                      const action = `user:${candidate.id}`;
                      const passkeyCount = credentials.filter((credential) => credential.userId === candidate.id && !credential.revokedAt).length;
                      return (
                        <SettingsTableRow key={candidate.id} size="member">
                          <SettingsTableCell><span className="flex min-w-0 items-center gap-2"><ProfileAvatar name={candidate.displayName} seed={candidate.avatarSeed} collection="pixel-art-neutral" /><span className="truncate">{candidate.displayName}</span></span></SettingsTableCell>
                          <SettingsTableCell className="truncate text-muted-foreground">@{candidate.username}</SettingsTableCell>
                          <SettingsTableCell><span className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">{candidate.role}</span></SettingsTableCell>
                          <SettingsTableCell className="text-muted-foreground">{candidate.companyIds.length}</SettingsTableCell>
                          <SettingsTableCell className="text-muted-foreground">{passkeyCount}</SettingsTableCell>
                          <SettingsTableCell><span className="flex items-center gap-1.5 text-muted-foreground"><span className={candidate.status === "active" ? "size-1.5 rounded-full bg-emerald-500" : candidate.status === "pending" ? "size-1.5 rounded-full bg-amber-500" : "size-1.5 rounded-full bg-muted-foreground"} />{candidate.status}</span></SettingsTableCell>
                          <SettingsTableCell className="p-0">{candidate.role !== "admin" && candidate.status === "active" ? <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`${candidate.displayName} actions`} title={`${candidate.displayName} actions`} />}><Ellipsis /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem variant="destructive" onClick={() => void revokeUser(candidate)}>{pendingAction === action ? "Confirm revoke" : "Revoke user"}</DropdownMenuItem>{pendingAction === action ? <DropdownMenuItem onClick={() => setPendingAction("")}>Cancel</DropdownMenuItem> : null}</DropdownMenuContent></DropdownMenu> : null}</SettingsTableCell>
                          <SettingsTableCell className="p-0" />
                        </SettingsTableRow>
                      );
                    })}
                  </SettingsTableGroup>
                );
              })}
              {users.length === 0 ? <SettingsTableEmpty columnCount={USER_COLUMNS.length}>No users configured.</SettingsTableEmpty> : null}
            </SettingsDataTable>
          </section>
        ) : null}

        {isProfiles ? (
          <>
            <section>
              <SettingsToolbar searchLabel="Filter profiles by name" searchPlaceholder="Filter by name…" filterLabel="All models" searchWidth="compact" actions={<SettingsToolbarAction tone="primary" onClick={openNewProfile}>New profile</SettingsToolbarAction>} />
              <SettingsDataTable label="Profiles" columns={PROFILE_COLUMNS} className="mt-10">
                <tbody>
                  {profiles.map((profile) => {
                    const lane = capacityLanes.find((item) => item.profileId === profile.id);
                    const edit = capacityEdits[profile.id] ?? (profile.capacity === null ? "" : String(profile.capacity));
                    const saved = profile.capacity === null ? "" : String(profile.capacity);
                    const formId = `capacity-${profile.id}`;
                    return (
                      <SettingsTableRow aria-label={`Edit ${profile.name}`} key={profile.id} onClick={(event) => { if (!(event.target as HTMLElement).closest("button, input")) openEditProfile(profile); }} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openEditProfile(profile); } }} tabIndex={0}>
                        <SettingsTableCell><span className="flex min-w-0 items-center gap-3"><span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">{profile.name[0]?.toUpperCase()}</span><span className="min-w-0"><span className="block truncate">{profile.name}</span><span className="block truncate text-[10px] leading-3 text-muted-foreground">{profile.capacity === null ? `Default · ${profile.effectiveCapacity} slots effective` : `Override · ${profile.capacity} slots`} · {lane?.activeCount ?? 0} active / {lane?.queuedCount ?? 0} queued</span></span></span></SettingsTableCell>
                        <SettingsTableCell className="capitalize">{profile.provider === "claude" ? "Claude Code" : "Codex"}</SettingsTableCell>
                        <SettingsTableCell className="truncate">{profile.model}</SettingsTableCell>
                        <SettingsTableCell className="truncate text-muted-foreground">{profile.reasoningLevel}</SettingsTableCell>
                        <SettingsTableCell className="truncate text-muted-foreground">{profile.servicePriority}</SettingsTableCell>
                        <SettingsTableCell><form id={formId} onSubmit={(event) => { event.preventDefault(); void updateCapacity(profile); }}><input aria-label={`${profile.name} capacity`} className="h-7 w-[86px] rounded-md border-[0.5px] border-border bg-transparent px-2 text-[12px] outline-none focus:border-ring" inputMode="numeric" placeholder="Default" value={edit} onChange={(event) => setCapacityEdits((current) => ({ ...current, [profile.id]: event.target.value }))} /></form></SettingsTableCell>
                        <SettingsTableCell className="p-0"><button aria-label="Save" className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-black/5 hover:text-foreground disabled:opacity-30" disabled={edit === saved} form={formId} title="Save capacity" type="submit"><Save className="size-3.5" /></button></SettingsTableCell>
                        <SettingsTableCell className="p-0"><Button variant="ghost" size="icon-xs" aria-label={`Edit ${profile.name}`} title={`Edit ${profile.name}`} onClick={() => openEditProfile(profile)}><Pencil /></Button></SettingsTableCell>
                      </SettingsTableRow>
                    );
                  })}
                </tbody>
                {profiles.length === 0 ? <SettingsTableEmpty columnCount={PROFILE_COLUMNS.length}>No profiles configured.</SettingsTableEmpty> : null}
              </SettingsDataTable>
            </section>
            <Dialog open={profileOpen} onOpenChange={(open) => { setProfileOpen(open); if (!open) setEditingProfileId(null); }}>
              <DialogContent>
                <DialogHeader><DialogTitle>{editingProfileId ? "Edit profile" : "New profile"}</DialogTitle><DialogDescription>Configure a reusable Codex execution profile.</DialogDescription></DialogHeader>
                <form onSubmit={(event) => { event.preventDefault(); void saveProfile(); }}>
                  <FieldGroup>
                    <Field><FieldLabel htmlFor="profile-name">Profile name</FieldLabel><Input id="profile-name" autoFocus value={profileName} onChange={(event) => setProfileName(event.target.value)} /></Field>
                    <Field><FieldLabel htmlFor="profile-provider">Provider</FieldLabel><Select value={profileProvider} onValueChange={(value) => { const provider = value as "codex" | "claude"; setProfileProvider(provider); if (!models.some((model) => model.status === "active" && model.provider === provider && model.id === profileModel)) setProfileModel(""); }}><SelectTrigger id="profile-provider"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="codex">Codex</SelectItem><SelectItem value="claude">Claude Code</SelectItem></SelectContent></Select></Field>
                    <Field><FieldLabel htmlFor="profile-model">Model</FieldLabel><Select value={profileModel || null} onValueChange={(value) => setProfileModel(value ?? "")}><SelectTrigger id="profile-model"><SelectValue placeholder="Select a model" /></SelectTrigger><SelectContent>{models.filter((model) => model.status === "active" && model.provider === profileProvider).map((model) => <SelectItem key={model.id} value={model.id}>{model.displayName} · {model.id}</SelectItem>)}</SelectContent></Select></Field>
                    <Field><FieldLabel htmlFor="profile-reasoning">Reasoning level</FieldLabel><Select value={profileReasoning} onValueChange={(value) => setProfileReasoning(value ?? "medium")}><SelectTrigger id="profile-reasoning"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="low">Low</SelectItem><SelectItem value="medium">Medium</SelectItem><SelectItem value="high">High</SelectItem><SelectItem value="xhigh">XHigh</SelectItem></SelectContent></Select></Field>
                    <Field><FieldLabel htmlFor="profile-priority">Service priority</FieldLabel><Select value={profilePriority} onValueChange={(value) => setProfilePriority(value ?? "standard")}><SelectTrigger id="profile-priority"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="standard">Standard</SelectItem><SelectItem value="priority">Priority</SelectItem><SelectItem value="fast">Fast</SelectItem></SelectContent></Select></Field>
                    <Field><FieldLabel htmlFor="profile-capacity">Capacity override</FieldLabel><Input id="profile-capacity" inputMode="numeric" placeholder="Default" value={profileCapacity} onChange={(event) => setProfileCapacity(event.target.value)} /><FieldDescription>Blank inherits the host default.</FieldDescription></Field>
                    <DialogFooter><DialogClose render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose><Button type="submit" size="sm" disabled={!profileName.trim() || !profileModel}>{editingProfileId ? "Save changes" : "Create profile"}</Button></DialogFooter>
                  </FieldGroup>
                </form>
              </DialogContent>
            </Dialog>
          </>
        ) : null}

        {isAgents ? (
          <div className="space-y-12">
            <section>
              <SettingsToolbar searchLabel="Filter internal agents by name" searchPlaceholder="Filter by name…" filterLabel="All roles" searchWidth="compact" actions={<SettingsToolbarAction tone="primary" onClick={openNewAgent}>New internal agent</SettingsToolbarAction>} />
              <SettingsDataTable label="Internal Agents" columns={AGENT_COLUMNS} className="mt-4">
                <SettingsTableGroup label="Internal agents" count={agents.length} columnCount={AGENT_COLUMNS.length}>
                  {sortedAgents.map((agent) => (
                    <SettingsTableRow aria-label={`Edit ${agent.name}`} key={agent.id} onClick={(event) => { if (!(event.target as HTMLElement).closest("button, input, label, [data-base-ui-portal]")) openEditAgent(agent); }} tabIndex={0}>
                      <SettingsTableCell><span className="flex min-w-0 items-center gap-3"><ProfileAvatar name={agent.name} seed={agent.avatarSeed} /><AgentNameEditor agent={agent} onSave={(name) => patchAgent(agent, { name }, "Unable to rename agent")} />{agent.archivedAt ? <Badge variant="secondary">Archived</Badge> : null}</span></SettingsTableCell>
                      <SettingsTableCell className="capitalize">{agent.role}</SettingsTableCell>
                      <SettingsTableCell className="truncate">{profiles.find((profile) => profile.id === agent.profileId)?.name ?? agent.profileId}</SettingsTableCell>
                      <SettingsTableCell><span className="flex items-center gap-1.5 text-muted-foreground"><span className={agent.archivedAt ? "size-1.5 rounded-full bg-muted-foreground" : "size-1.5 rounded-full bg-emerald-500"} />{agent.archivedAt ? "archived" : "active"}</span></SettingsTableCell>
                      <SettingsTableCell className="p-0">
                        <DropdownMenu>
                          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`${agent.name} actions`} title={`${agent.name} actions`} />}><Ellipsis /></DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => void duplicateAgent(agent)}><Copy />Duplicate</DropdownMenuItem>
                            {agent.archivedAt
                              ? <DropdownMenuItem onClick={() => void patchAgent(agent, { archived: false }, "Unable to unarchive agent")}><ArchiveRestore />Unarchive</DropdownMenuItem>
                              : <DropdownMenuItem onClick={() => setArchiveTarget(agent)}><Archive />Archive</DropdownMenuItem>}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </SettingsTableCell>
                      <SettingsTableCell className="p-0"><Button variant="ghost" size="icon-xs" aria-label={`Edit ${agent.name}`} title={`Edit ${agent.name}`} onClick={() => openEditAgent(agent)}><Pencil /></Button></SettingsTableCell>
                    </SettingsTableRow>
                  ))}
                </SettingsTableGroup>
                {agents.length === 0 ? <SettingsTableEmpty columnCount={AGENT_COLUMNS.length}>No internal agents configured.</SettingsTableEmpty> : null}
              </SettingsDataTable>
              <AlertDialog open={archiveTarget !== null} onOpenChange={(open) => { if (!open) setArchiveTarget(null); }}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Archive {archiveTarget?.name}?</AlertDialogTitle>
                    <AlertDialogDescription>Archived agents disappear from task and project pickers. Tasks already assigned to this agent keep running, and you can unarchive it later.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={() => { const target = archiveTarget; setArchiveTarget(null); if (target) void patchAgent(target, { archived: true }, "Unable to archive agent"); }}>Archive</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </section>

            <section>
              <div className="flex justify-end"><Button size="sm" onClick={openNewHermesAgent}>New Hermes agent</Button></div>
              <SettingsDataTable label="Hermes Agents" columns={HERMES_AGENT_COLUMNS} className="mt-4">
                <SettingsTableGroup label="Hermes agents" count={hermesAgents.length} columnCount={HERMES_AGENT_COLUMNS.length}>
                  {hermesAgents.map((agent) => {
                    const action = `hermes:revoke:${agent.id}`;
                    return (
                      <SettingsTableRow aria-label={`Hermes agent ${agent.name}`} key={agent.id}>
                        <SettingsTableCell>
                          <span className="flex items-center gap-3">
                            <ProfileAvatar name={agent.name} seed={agent.avatarSeed} collection="bottts-neutral" />
                            <span className="truncate font-medium">{agent.name}</span>
                          </span>
                        </SettingsTableCell>
                        <SettingsTableCell>
                          <span className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
                            <span className={agent.status === "paired" ? "size-1.5 shrink-0 rounded-full bg-emerald-500" : agent.status === "pending" ? "size-1.5 shrink-0 rounded-full bg-amber-500" : "size-1.5 shrink-0 rounded-full bg-muted-foreground"} />
                            <span>{agent.status === "pending" && agent.pairingExpiresAt ? `Pending until ${adminDate(agent.pairingExpiresAt)}` : agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}</span>
                          </span>
                        </SettingsTableCell>
                        <SettingsTableCell>
                          <span className="truncate text-muted-foreground" title={agent.projectIds.map((id) => companyProjects.find((p) => p.id === id)?.name ?? id).join(", ")}>
                            {agent.projectIds.length === 0 ? "None" : agent.projectIds.map((id) => companyProjects.find((p) => p.id === id)?.name ?? id).join(", ")}
                          </span>
                        </SettingsTableCell>
                        <SettingsTableCell className="truncate text-muted-foreground text-xs">
                          {agent.credentialCreatedAt ? adminDate(agent.credentialCreatedAt) : "—"}
                        </SettingsTableCell>
                        <SettingsTableCell className="truncate text-muted-foreground text-xs">
                          {agent.lastUsedAt ? adminDate(agent.lastUsedAt) : "Never"}
                        </SettingsTableCell>
                        <SettingsTableCell className="p-0">
                          {agent.status !== "revoked" ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`${agent.name} actions`} title={`${agent.name} actions`} />}>
                                <Ellipsis className="size-4" />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {agent.status === "pending" ? (
                                  <DropdownMenuItem onClick={() => void reissueHermesPairing(agent)}>
                                    <Key className="mr-2 size-3.5" /> Reissue pairing code
                                  </DropdownMenuItem>
                                ) : (
                                  <DropdownMenuItem onClick={() => void rotateHermesAgent(agent)}>
                                    <RotateCw className="mr-2 size-3.5" /> Rotate credential
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem onClick={() => openEditHermesProjects(agent)}>
                                  <Pencil className="mr-2 size-3.5" /> Edit project scope
                                </DropdownMenuItem>
                                <DropdownMenuItem variant="destructive" onClick={() => void revokeHermesAgent(agent)}>
                                  <ShieldAlert className="mr-2 size-3.5" /> {pendingAction === action ? "Confirm revoke" : "Revoke agent"}
                                </DropdownMenuItem>
                                {pendingAction === action ? <DropdownMenuItem onClick={() => setPendingAction("")}>Cancel</DropdownMenuItem> : null}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : null}
                        </SettingsTableCell>
                        <SettingsTableCell className="p-0" />
                      </SettingsTableRow>
                    );
                  })}
                </SettingsTableGroup>
                {hermesAgents.length === 0 ? <SettingsTableEmpty columnCount={HERMES_AGENT_COLUMNS.length}>No Hermes agents configured.</SettingsTableEmpty> : null}
              </SettingsDataTable>
            </section>

            {/* Internal agent dialog */}
            <Dialog open={agentOpen} onOpenChange={(open) => { setAgentOpen(open); if (!open) setEditingAgentId(null); }}>
              <DialogContent>
                <DialogHeader><DialogTitle>{editingAgentId ? "Edit agent" : "New internal agent"}</DialogTitle><DialogDescription>Assign a stable role identity to an execution profile.</DialogDescription></DialogHeader>
                <form onSubmit={(event) => { event.preventDefault(); void saveAgent(); }}>
                  <FieldGroup>
                    <Field><FieldLabel>Avatar</FieldLabel><span className="flex items-center gap-3"><ProfileAvatar name={agentName || "Agent"} seed={agentAvatarSeed} /><Button type="button" variant="outline" size="sm" onClick={() => setAgentAvatarSeed(crypto.randomUUID().replaceAll("-", ""))}>Randomize</Button></span></Field>
                    <Field><FieldLabel htmlFor="agent-name">Agent name</FieldLabel><Input id="agent-name" autoFocus value={agentName} onChange={(event) => setAgentName(event.target.value)} /></Field>
                    <Field><FieldLabel htmlFor="agent-role">Role</FieldLabel><Select value={agentRole} onValueChange={(value) => setAgentRole((value ?? "planner") as typeof agentRole)}><SelectTrigger id="agent-role"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="planner">Planner</SelectItem><SelectItem value="reviewer">Reviewer</SelectItem><SelectItem value="builder">Builder</SelectItem><SelectItem value="integrator">Integrator</SelectItem></SelectContent></Select></Field>
                    <Field><FieldLabel htmlFor="agent-profile">Execution profile</FieldLabel><Select value={agentProfileId || null} onValueChange={(value) => setAgentProfileId(value ?? "")}><SelectTrigger id="agent-profile"><SelectValue placeholder="Select a profile" /></SelectTrigger><SelectContent>{profiles.map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>)}</SelectContent></Select></Field>
                    <DialogFooter><DialogClose render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose><Button type="submit" size="sm" disabled={!agentName.trim() || !agentProfileId}>{editingAgentId ? "Save changes" : "Create agent"}</Button></DialogFooter>
                  </FieldGroup>
                </form>
              </DialogContent>
            </Dialog>

            {/* New Hermes agent dialog */}
            <Dialog open={newHermesOpen} onOpenChange={setNewHermesOpen}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>New Hermes agent</DialogTitle>
                  <DialogDescription>Create a scoped external agent for autonomous task creation and tracking.</DialogDescription>
                </DialogHeader>
                <form onSubmit={(event) => { event.preventDefault(); void createHermesAgent(); }}>
                  <FieldGroup>
                    <Field>
                      <FieldLabel>Avatar</FieldLabel>
                      <span className="flex items-center gap-3">
                        <ProfileAvatar name={hermesName || "Hermes"} seed={hermesAvatarSeed} collection="bottts-neutral" />
                        <Button type="button" variant="outline" size="sm" onClick={() => setHermesAvatarSeed(crypto.randomUUID().replaceAll("-", ""))}>Randomize</Button>
                      </span>
                    </Field>
                    <Field data-invalid={Boolean(hermesError)}>
                      <FieldLabel htmlFor="hermes-name">Agent name</FieldLabel>
                      <Input id="hermes-name" autoFocus aria-invalid={Boolean(hermesError)} placeholder="e.g. SRE Hermes Bot" value={hermesName} onChange={(event) => { setHermesName(event.target.value); setHermesError(""); }} />
                      <FieldError>{hermesError}</FieldError>
                    </Field>
                    <Field>
                      <FieldLabel>Allowed projects</FieldLabel>
                      <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border p-2">
                        {companyProjects.map((project) => {
                          const checked = hermesProjectIds.includes(project.id);
                          return (
                            <label key={project.id} className="flex cursor-pointer items-center gap-2 text-xs">
                              <Checkbox
                                checked={checked}
                                onCheckedChange={(val) => {
                                  if (val) setHermesProjectIds((prev) => [...prev, project.id]);
                                  else setHermesProjectIds((prev) => prev.filter((id) => id !== project.id));
                                }}
                              />
                              <span className="font-medium">{project.name}</span>
                              <span className="text-muted-foreground">({project.repository})</span>
                            </label>
                          );
                        })}
                        {companyProjects.length === 0 ? <span className="text-xs text-muted-foreground">No projects found in this workspace.</span> : null}
                      </div>
                      <FieldDescription>The agent will only be permitted to create and inspect tasks within selected projects.</FieldDescription>
                    </Field>
                    <DialogFooter>
                      <DialogClose render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose>
                      <Button type="submit" size="sm" disabled={!hermesName.trim() || hermesProjectIds.length === 0}>Create Hermes agent</Button>
                    </DialogFooter>
                  </FieldGroup>
                </form>
              </DialogContent>
            </Dialog>

            {/* Hermes pairing code modal */}
            <Dialog open={pairingCodeModalOpen} onOpenChange={setPairingCodeModalOpen}>
              <DialogContent aria-label="Pairing code">
                <div className="min-w-0 space-y-3 py-2">
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2"><p className="text-sm font-medium">Paste into Hermes</p><Badge variant="secondary">Recommended</Badge></div>
                      <p className="text-[11px] text-muted-foreground">Paste them into the Hermes profile you are pairing.</p>
                    </div>
                    <Field>
                      <FieldLabel htmlFor="hermes-profile-name">Hermes profile name</FieldLabel>
                      <Input id="hermes-profile-name" value={hermesProfileName} onChange={(event) => { setHermesProfileName(event.target.value); setPairingInstructionsCopied(false); }} />
                    </Field>
                    <button type="button" className="relative w-full max-w-full cursor-pointer rounded-md border bg-muted/50 p-3 pr-10 text-left font-mono text-xs" aria-label="Copy setup instructions" onClick={() => void copyHermesSetupInstructions()}>
                      <span className="block h-12 overflow-hidden whitespace-pre-wrap break-words">{hermesSetupInstructions().replaceAll("\n\n", "\n")}</span>
                      <span className="absolute top-1/2 right-2 -translate-y-1/2">
                        {pairingInstructionsCopied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                      </span>
                    </button>
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">or</div>
                  <div className="space-y-2">
                    <div>
                      <p className="text-sm font-medium">Manual setup</p>
                      <p className="text-[11px] text-muted-foreground">Use this single-use code to configure the Hermes profile yourself.</p>
                    </div>
                    <button type="button" className="relative w-full max-w-full cursor-pointer rounded-md border bg-muted/50 p-3 pr-10 text-left font-mono text-xs" aria-label="Copy pairing code" onClick={() => void copyPairingCode()}>
                      <span className="block truncate">{pairingCodeData?.code}</span>
                      <span className="absolute top-1/2 right-2 -translate-y-1/2">
                        {pairingCodeCopied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                      </span>
                    </button>
                    {pairingCodeData?.expiresAt ? <p className="text-[11px] text-muted-foreground">Expires {adminDate(pairingCodeData.expiresAt)}</p> : null}
                  </div>
                </div>
                {pairingCodeCopied || pairingInstructionsCopied ? <span className="pointer-events-none fixed top-4 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-[11px] text-popover-foreground animate-in slide-in-from-top-2 duration-150" role="status" aria-live="polite">Copied to Clipboard</span> : null}
                <DialogFooter>
                  <DialogClose render={<Button type="button" size="sm" disabled={!pairingCodeCopied && !pairingInstructionsCopied} />}>{pairingCodeCopied || pairingInstructionsCopied ? "Continue" : "Copy to Continue"}</DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            {/* Hermes edit projects dialog */}
            <Dialog open={editProjectsModalOpen} onOpenChange={setEditProjectsModalOpen}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Edit allowed projects</DialogTitle>
                  <DialogDescription>Manage project access grants for {editingHermesAgent?.name}.</DialogDescription>
                </DialogHeader>
                <form onSubmit={(event) => { event.preventDefault(); void saveHermesProjects(); }}>
                  <FieldGroup>
                    <Field>
                      <FieldLabel>Projects</FieldLabel>
                      <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border p-2">
                        {companyProjects.map((project) => {
                          const checked = editingHermesProjectIds.includes(project.id);
                          return (
                            <label key={project.id} className="flex cursor-pointer items-center gap-2 text-xs">
                              <Checkbox
                                checked={checked}
                                onCheckedChange={(val) => {
                                  if (val) setEditingHermesProjectIds((prev) => [...prev, project.id]);
                                  else setEditingHermesProjectIds((prev) => prev.filter((id) => id !== project.id));
                                }}
                              />
                              <span className="font-medium">{project.name}</span>
                              <span className="text-muted-foreground">({project.repository})</span>
                            </label>
                          );
                        })}
                      </div>
                    </Field>
                    <DialogFooter>
                      <DialogClose render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose>
                      <Button type="submit" size="sm">Save project grants</Button>
                    </DialogFooter>
                  </FieldGroup>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        ) : null}

        {isCompanies ? (
          <section>
            <SettingsToolbar searchLabel="Search companies" searchPlaceholder="Search companies…" filterLabel="All" searchWidth="compact" actions={null} />
            <SettingsDataTable label="Companies" columns={COMPANY_COLUMNS} className="mt-5">
              <SettingsTableGroup columnCount={COMPANY_COLUMNS.length} count={companies.length} label="Companies">
                {companies.map((company) => (
                  <SettingsTableRow key={company.id} size="member">
                    <SettingsTableCell className="truncate font-medium">{company.name}</SettingsTableCell>
                    <SettingsTableCell className="truncate text-muted-foreground">{company.issueCode ?? "—"}</SettingsTableCell>
                    <SettingsTableCell><span className="flex items-center gap-1.5 text-muted-foreground"><span className={company.status === "active" ? "size-1.5 rounded-full bg-emerald-500" : company.status === "paused" ? "size-1.5 rounded-full bg-amber-500" : "size-1.5 rounded-full bg-muted-foreground"} />{company.status}</span></SettingsTableCell>
                    <SettingsTableCell className="truncate text-muted-foreground">{adminDate(company.createdAt)}</SettingsTableCell>
                    <SettingsTableCell className="p-0"><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`${company.name} actions`} title={`${company.name} actions`} />}><Ellipsis /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => window.location.assign(withCompany(`/companies/${encodeURIComponent(company.id)}/settings`, company.id))}>Settings</DropdownMenuItem>{users.filter((candidate) => candidate.role === "member" && candidate.status === "active").map((candidate) => { const assigned = candidate.companyIds.includes(company.id); const action = `membership:${company.id}:${candidate.id}`; return <DropdownMenuItem key={candidate.id} onClick={() => void changeMembership(company.id, candidate.id, !assigned)}>{pendingAction === action ? `Confirm remove ${candidate.displayName}` : `${assigned ? "Remove" : "Add"} ${candidate.displayName}`}</DropdownMenuItem>; })}{pendingAction.startsWith(`membership:${company.id}:`) ? <DropdownMenuItem onClick={() => setPendingAction("")}>Cancel membership change</DropdownMenuItem> : null}</DropdownMenuContent></DropdownMenu></SettingsTableCell>
                    <SettingsTableCell className="p-0" />
                  </SettingsTableRow>
                ))}
              </SettingsTableGroup>
              {companies.length === 0 ? <SettingsTableEmpty columnCount={COMPANY_COLUMNS.length}>No companies configured.</SettingsTableEmpty> : null}
            </SettingsDataTable>
          </section>
        ) : null}

        {isInvitations ? (
          <>
            <section>
              <SettingsToolbar searchLabel="Search invitations" searchPlaceholder="Search invitations…" filterLabel="All" searchWidth="compact" actions={<SettingsToolbarAction tone="primary" onClick={() => { setInviteToken(""); setCopied(false); setInviteOpen(true); }}>Invite</SettingsToolbarAction>} />
              <SettingsDataTable label="Invitations" columns={INVITATION_COLUMNS} className="mt-5">
                <SettingsTableGroup columnCount={INVITATION_COLUMNS.length} count={invitations.length} label="Invitations">
                  {invitations.map((invitation) => (
                    <SettingsTableRow key={invitation.id} size="member">
                      <SettingsTableCell className="truncate font-medium">{invitation.displayName}</SettingsTableCell>
                      <SettingsTableCell className="capitalize text-muted-foreground">{invitation.kind}</SettingsTableCell>
                      <SettingsTableCell className="text-muted-foreground">—</SettingsTableCell>
                      <SettingsTableCell className="truncate text-muted-foreground">{adminDate(invitation.expiresAt)}</SettingsTableCell>
                      <SettingsTableCell className="capitalize text-muted-foreground">{invitation.status}</SettingsTableCell>
                    </SettingsTableRow>
                  ))}
                </SettingsTableGroup>
                {invitations.length === 0 ? <SettingsTableEmpty columnCount={INVITATION_COLUMNS.length}>No invitations configured.</SettingsTableEmpty> : null}
              </SettingsDataTable>
            </section>
            <Dialog open={inviteOpen} onOpenChange={(open) => { setInviteOpen(open); if (!open) { setInviteToken(""); setCopied(false); } }}><DialogContent><DialogHeader><DialogTitle>{inviteToken ? "Invitation ready" : "Invite user"}</DialogTitle><DialogDescription>{inviteToken ? `Shown once · expires ${adminDate(inviteExpiresAt)}` : "Create an invitation for a Forge user."}</DialogDescription></DialogHeader>{inviteToken ? <><code className="break-all text-xs">{inviteToken}</code><DialogFooter><DialogClose render={<Button type="button" variant="outline" size="sm" />}>Close</DialogClose><Button type="button" size="sm" onClick={() => void copyInvitation()}>{copied ? "Copied" : "Copy invitation"}</Button></DialogFooter></> : <form onSubmit={(event) => { event.preventDefault(); void invite(); }}><FieldGroup><Field><FieldLabel htmlFor="invite-display-name">Display name</FieldLabel><Input id="invite-display-name" autoFocus placeholder="Forge user" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field><DialogFooter><DialogClose render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose><Button type="submit" size="sm">Invite</Button></DialogFooter></FieldGroup></form>}</DialogContent></Dialog>
          </>
        ) : null}

        {isPasskeys ? (
          <section>
            <SettingsToolbar searchLabel="Search passkeys" searchPlaceholder="Search passkeys…" filterLabel="All" searchWidth="compact" actions={null} />
            <SettingsDataTable label="Passkeys" columns={PASSKEY_COLUMNS} className="mt-5">
              <SettingsTableGroup columnCount={PASSKEY_COLUMNS.length} count={credentials.filter((credential) => !credential.revokedAt).length} label="Passkeys">
                {credentials.map((credential) => {
                  const candidate = users.find((entry) => entry.id === credential.userId);
                  const action = `credential:${credential.id}`;
                  return (
                    <SettingsTableRow key={credential.id} size="member">
                      <SettingsTableCell className="truncate font-medium">{credential.credentialId}</SettingsTableCell>
                      <SettingsTableCell className="truncate text-muted-foreground">{candidate?.displayName ?? "User"}</SettingsTableCell>
                      <SettingsTableCell className="truncate text-muted-foreground">{adminDate(credential.createdAt)}</SettingsTableCell>
                      <SettingsTableCell className="text-muted-foreground">—</SettingsTableCell>
                      <SettingsTableCell className="text-muted-foreground">{credential.revokedAt ? "revoked" : "active"}</SettingsTableCell>
                      <SettingsTableCell className="p-0">{!credential.revokedAt && credential.userId !== user.id ? <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`${credential.credentialId} actions`} title={`${credential.credentialId} actions`} />}><Ellipsis /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem variant="destructive" onClick={() => void revokeCredential(credential)}>{pendingAction === action ? "Confirm revoke" : "Revoke passkey"}</DropdownMenuItem>{pendingAction === action ? <DropdownMenuItem onClick={() => setPendingAction("")}>Cancel</DropdownMenuItem> : null}</DropdownMenuContent></DropdownMenu> : null}</SettingsTableCell>
                      <SettingsTableCell className="p-0" />
                    </SettingsTableRow>
                  );
                })}
              </SettingsTableGroup>
              {credentials.length === 0 ? <SettingsTableEmpty columnCount={PASSKEY_COLUMNS.length}>No passkeys configured.</SettingsTableEmpty> : null}
            </SettingsDataTable>
          </section>
        ) : null}

        {isModels ? (
          <>
            <section>
              <SettingsToolbar searchLabel="Search models" searchPlaceholder="Search models…" filterLabel="All" searchWidth="compact" actions={<SettingsToolbarAction tone="primary" onClick={() => setModelOpen(true)}>Add model</SettingsToolbarAction>} />
              <SettingsDataTable label="Models" columns={MODEL_COLUMNS} className="mt-5">
                <SettingsTableGroup columnCount={MODEL_COLUMNS.length} count={models.filter((model) => model.status === "active").length} label="Model catalog">
                  {models.map((model) => (
                    <SettingsTableRow key={model.id} size="member">
                      <SettingsTableCell className="truncate"><code className="text-[11px] text-muted-foreground">{model.id}</code></SettingsTableCell>
                      <SettingsTableCell className="capitalize">{model.provider === "claude" ? "Claude Code" : "Codex"}</SettingsTableCell>
                      <SettingsTableCell className="truncate">{model.displayName}{model.description ? <span className="ml-1 text-muted-foreground">· {model.description}</span> : null}</SettingsTableCell>
                      <SettingsTableCell className="text-muted-foreground">{model.status}</SettingsTableCell>
                      <SettingsTableCell className="text-muted-foreground">{model.sortOrder}</SettingsTableCell>
                      <SettingsTableCell className="p-0"><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`${model.displayName} actions`} title={`${model.displayName} actions`} />}><Ellipsis /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem variant={model.status === "active" ? "destructive" : "default"} onClick={() => void toggleModel(model)}>{model.status === "active" ? "Retire model" : "Restore model"}</DropdownMenuItem></DropdownMenuContent></DropdownMenu></SettingsTableCell>
                      <SettingsTableCell className="p-0" />
                    </SettingsTableRow>
                  ))}
                </SettingsTableGroup>
                {models.length === 0 ? <SettingsTableEmpty columnCount={MODEL_COLUMNS.length}>No models configured.</SettingsTableEmpty> : null}
              </SettingsDataTable>
            </section>
            <Dialog open={modelOpen} onOpenChange={setModelOpen}><DialogContent><DialogHeader><DialogTitle>Add model</DialogTitle><DialogDescription>Make a model available to new profiles.</DialogDescription></DialogHeader><form onSubmit={(event) => { event.preventDefault(); void createModel(); }}><FieldGroup><Field><FieldLabel htmlFor="model-id">Model ID</FieldLabel><Input id="model-id" autoFocus placeholder="gpt-5-codex" value={modelId} onChange={(event) => setModelId(event.target.value)} /></Field><Field><FieldLabel htmlFor="model-display-name">Display name</FieldLabel><Input id="model-display-name" value={modelName} onChange={(event) => setModelName(event.target.value)} /></Field><DialogFooter><DialogClose render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose><Button type="submit" size="sm" disabled={!modelId.trim() || !modelName.trim()}>Add model</Button></DialogFooter></FieldGroup></form></DialogContent></Dialog>
          </>
        ) : null}

        {error ? <div className="px-4 py-3 text-xs text-rose-700"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
      </div>
    </SettingsLayout>
  );
}
