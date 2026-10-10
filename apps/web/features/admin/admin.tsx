import { CompanyInvitations } from "./company-invitations.js";
import { listCompanyInvitations } from "./company-users-api.js";
import type { CompanyInvitation } from "../../contracts/generated/CompanyInvitation.js";
import { Button } from "../../components/ui/button.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { SettingRow, SettingsContent, SettingsLayout, SettingsSection } from "../settings/settings-layout.js";
import { readJsonUnchecked, withCompany, type ApiUser } from "../../lib/api.js";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import type {
  ApiProfile,
  ApiExternalAgent,
  ApiProject,
} from "../../shell/view-shared.js";
import { UsersSection } from "./users-section.js";
import { CompaniesSection } from "./companies-section.js";
import { InternalAgentsManager } from "./internal-agents-manager.js";
import { ExternalAgentsSection } from "./external-agents-section.js";
import { ExternalAgentAvatarDialog } from "./external-agent-avatar-dialog.js";
import { ExternalAgentNewAgentDialog } from "./external-agent-new-dialog.js";
import { ExternalAgentPairingCodeDialog } from "./external-agent-pairing-code-dialog.js";
import { ExternalAgentProjectGrantsDialog } from "./external-agent-project-grants-dialog.js";
import { createExternalAgentActions } from "./external-agent-actions.js";
import { LoadingState } from "../../components/app/loading-state.js";

export function AdminView(): ReactElement {
  const { user, companies, currentCompany, loading } = useCompanyContext();
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [invitations, setInvitations] = useState<CompanyInvitation[]>([]);
  const [agents, setAgents] = useState<ApiProfile[]>([]);
  const [externalAgents, setExternalAgents] = useState<ApiExternalAgent[]>([]);
  const [companyProjects, setCompanyProjects] = useState<ApiProject[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState("");
  const [error, setError] = useState("");
  const [initialReloading, setInitialReloading] = useState(true);

  // External agent administration state
  const [newExternalAgentOpen, setNewExternalAgentOpen] = useState(false);
  const [externalAgentName, setExternalAgentName] = useState("");
  const [externalAgentError, setExternalAgentError] = useState("");
  const [externalAgentProjectIds, setExternalAgentProjectIds] = useState<string[]>([]);
  const [externalAgentAvatarSeed, setExternalAgentAvatarSeed] = useState("");
  const [externalAgentAvatarTarget, setExternalAgentAvatarTarget] =
    useState<ApiExternalAgent | null>(null);
  const [pairingCodeModalOpen, setPairingCodeModalOpen] = useState(false);
  const [pairingCodeData, setPairingCodeData] = useState<{
    code: string;
    expiresAt: string;
    agentName: string;
  } | null>(null);
  const [externalAgentProfileName, setExternalAgentProfileName] = useState("default");
  const [pairingCodeCopied, setPairingCodeCopied] = useState(false);
  const [pairingInstructionsCopied, setPairingInstructionsCopied] =
    useState(false);
  const [editProjectsModalOpen, setEditProjectsModalOpen] = useState(false);
  const [editingExternalAgent, setEditingExternalAgent] =
    useState<ApiExternalAgent | null>(null);
  const [editingExternalAgentProjectIds, setEditingExternalAgentProjectIds] = useState<
    string[]
  >([]);

  const isAgents = window.location.pathname.endsWith("/agents");
  const isCompanies = window.location.pathname.endsWith("/companies");

  const reload = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      const options = signal ? { signal } : {};
      const needsUsers = !isAgents;
      try {
        setError("");
        const [
          userList,
          invitationList,
          agentList,
          externalAgentList,
          projectList,
        ] = await Promise.all([
          needsUsers
            ? readJsonUnchecked<{ users: ApiUser[] }>("/api/admin/users", options)
            : { users: [] },
          !isAgents && !isCompanies && currentCompany
            ? listCompanyInvitations(currentCompany.id, signal)
            : { invitations: [] },
          isAgents
            ? readJsonUnchecked<{ profiles: ApiProfile[] }>(
                "/api/profiles?includeArchived=true",
                options,
              )
            : { profiles: [] },
          isAgents
            ? readJsonUnchecked<{ agents: ApiExternalAgent[] }>(
                `/api/admin/external-agents${currentCompany ? `?companyId=${encodeURIComponent(currentCompany.id)}` : ""}`,
                options,
              ).catch(() => ({ agents: [] }))
            : { agents: [] },
          isAgents && currentCompany
            ? readJsonUnchecked<{ projects: ApiProject[] }>(
                `/api/companies/${encodeURIComponent(currentCompany.id)}/projects`,
                options,
              ).catch(() => ({ projects: [] }))
            : Promise.resolve({ projects: [] }),
        ]);
        if (signal?.aborted) return;
        setUsers(userList.users);
        setInvitations(invitationList.invitations);
        setAgents(agentList.profiles);
        setExternalAgents(externalAgentList.agents);
        setCompanyProjects(projectList.projects);
        const projectIds = new Set(
          projectList.projects.map((project) => project.id),
        );
        setExternalAgentProjectIds((selected) =>
          selected.filter((projectId) => projectIds.has(projectId)),
        );
        setEditingExternalAgentProjectIds((selected) =>
          selected.filter((projectId) => projectIds.has(projectId)),
        );
      } catch (reason) {
        if (signal?.aborted) return;
        if (
          reason instanceof Error &&
          reason.message === "Authentication required"
        )
          window.location.assign("/auth");
        else setError("Unable to load administration");
      }
    },
    [
      currentCompany,
      isAgents,
      isCompanies,
    ],
  );

  useEffect(() => {
    if (loading || user?.role !== "admin") return;
    const controller = new AbortController();
    setInitialReloading(true);
    void reload(controller.signal).finally(() => {
      if (!controller.signal.aborted) setInitialReloading(false);
    });
    return () => {
      controller.abort();
    };
  }, [loading, reload, user?.role]);

  const {
    openNewExternalAgent,
    createExternalAgent,
    reissueExternalAgentPairing,
    rotateExternalAgent,
    revokeExternalAgent,
    openEditExternalAgentProjects,
    saveExternalAgentProjects,
    setAnswerGrant,
    setMovesGrant,
    copyPairingCode,
    copyExternalAgentSetupInstructions,
  } = createExternalAgentActions({
    currentCompany,
    externalAgentName,
    externalAgentProjectIds,
    externalAgentAvatarSeed,
    editingExternalAgent,
    editingExternalAgentProjectIds,
    pairingCodeData,
    externalAgentProfileName,
    pendingAction,
    reload,
    setNewExternalAgentOpen,
    setExternalAgentName,
    setExternalAgentError,
    setExternalAgentProjectIds,
    setExternalAgentAvatarSeed,
    setPairingCodeData,
    setExternalAgentProfileName,
    setPairingCodeCopied,
    setPairingInstructionsCopied,
    setPairingCodeModalOpen,
    setPendingAction,
    setEditingExternalAgent,
    setEditingExternalAgentProjectIds,
    setEditProjectsModalOpen,
    setError,
  });

  const changeMembership = async (
    companyId: string,
    targetUserId: string,
    add: boolean,
  ): Promise<void> => {
    const action = `membership:${companyId}:${targetUserId}`;
    if (!add && pendingAction !== action) {
      setPendingAction(action);
      return;
    }
    try {
      const init: RequestInit = { method: add ? "POST" : "DELETE" };
      if (add) init.body = JSON.stringify({ userId: targetUserId });
      await readJsonUnchecked(
        add
          ? `/api/admin/companies/${companyId}/members`
          : `/api/admin/companies/${companyId}/members/${targetUserId}`,
        init,
      );
      await reload();
      setPendingAction("");
    } catch {
      setError("Unable to change membership");
    }
  };
  // Team chooses what each member can see and change. On Free and Pro every
  // member sees every company, so removing a user revokes the account.
  const canScope = currentCompany?.plan === "team" || currentCompany?.teamLapsed === true;
  const setAccess = async (candidate: ApiUser, access: "edit" | "read"): Promise<void> => {
    if (!currentCompany) return;
    try {
      await readJsonUnchecked(`/api/admin/companies/${currentCompany.id}/members/${candidate.id}`, { method: "PATCH", body: JSON.stringify({ access }) });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to change access");
    }
  };
  const revokeUser = async (candidate: ApiUser): Promise<void> => {
    if (!currentCompany) return;
    const action = `user:${candidate.id}`;
    if (pendingAction !== action) {
      setPendingAction(action);
      return;
    }
    try {
      await readJsonUnchecked(canScope ? `/api/admin/companies/${currentCompany.id}/members/${candidate.id}` : `/api/admin/users/${candidate.id}/revoke`, { method: canScope ? "DELETE" : "POST" });
      setPendingAction("");
      await reload();
    } catch {
      setError("Unable to remove user");
    }
  };
  const viewTitle = isAgents
    ? "Agents"
    : isCompanies
      ? "Companies"
      : "Users";
  const viewDescription = isAgents
    ? "Agents plan and build the work of each task. Suplex runs internal agents. External agents connect to Suplex."
    : isCompanies
      ? "Each company has its own projects and tasks. Select the accounts that can open each company."
      : "Members must connect to this company’s host over Tailscale or the same local network.";
  const activeHref = withCompany(window.location.pathname, currentCompany?.id);
  const backHref = withCompany("/projects", currentCompany?.id);

  if (loading || (user?.role === "admin" && initialReloading)) {
    return (
      <SettingsLayout
        title={viewTitle}
        companyId={currentCompany?.id ?? ""}
        backHref={backHref}
        activeHref={activeHref}
        contentClassName=""
      >
        <LoadingState />
      </SettingsLayout>
    );
  }
  if (user?.role !== "admin") {
    return (
      <SettingsLayout
        title={viewTitle}
        companyId={currentCompany?.id ?? ""}
        backHref={backHref}
        activeHref={activeHref}
        contentClassName=""
      >
        <SettingsContent title={viewTitle}>
          <SettingsSection>
            <SettingRow label="Administration is not available" description="Only administrators can open this page." />
          </SettingsSection>
        </SettingsContent>
      </SettingsLayout>
    );
  }

  return (
    <SettingsLayout
      title={viewTitle}
      companyId={currentCompany?.id ?? ""}
      backHref={backHref}
      activeHref={activeHref}
      contentClassName=""
    >
      <SettingsContent width="wide" title={viewTitle} description={viewDescription} actions={!isAgents && !isCompanies ? <Button size="sm" disabled={!currentCompany} onClick={() => setInviteOpen(true)}>Add User</Button> : null}>
        {!isAgents &&
        !isCompanies ? (
          <UsersSection
            users={users.filter(candidate => candidate.role === "admin" || candidate.companyIds.includes(currentCompany?.id ?? ""))}
            pendingAction={pendingAction}
            companyId={currentCompany?.id ?? ""}
            canScope={canScope}
            onSetAccess={(candidate, access) => void setAccess(candidate, access)}
            onRevokeUser={(candidate) => void revokeUser(candidate)}
            onClearPendingAction={() => setPendingAction("")}
          />
        ) : null}

        {isAgents ? (
          <div className="space-y-12">
            <InternalAgentsManager agents={agents} onSaved={reload} />
            <ExternalAgentsSection
              agents={externalAgents}
              projects={companyProjects}
              pendingAction={pendingAction}
              onOpenNewAgent={openNewExternalAgent}
              onReissuePairing={reissueExternalAgentPairing}
              onRotateAgent={rotateExternalAgent}
              onEditProjects={openEditExternalAgentProjects}
              onEditAvatar={setExternalAgentAvatarTarget}
              onSetAnswerGrant={setAnswerGrant}
              onSetMovesGrant={setMovesGrant}
              onRevokeAgent={revokeExternalAgent}
              onClearPendingAction={() => setPendingAction("")}
            />
            <ExternalAgentAvatarDialog
              target={externalAgentAvatarTarget}
              onTargetChange={setExternalAgentAvatarTarget}
            />
            <ExternalAgentNewAgentDialog
              open={newExternalAgentOpen}
              name={externalAgentName}
              error={externalAgentError}
              projectIds={externalAgentProjectIds}
              projects={companyProjects}
              avatarSeed={externalAgentAvatarSeed}
              onOpenChange={setNewExternalAgentOpen}
              onNameChange={(value) => {
                setExternalAgentName(value);
                setExternalAgentError("");
              }}
              onProjectIdsChange={setExternalAgentProjectIds}
              onAvatarSeedChange={setExternalAgentAvatarSeed}
              onCreate={createExternalAgent}
            />
            <ExternalAgentPairingCodeDialog
              open={pairingCodeModalOpen}
              data={pairingCodeData}
              profileName={externalAgentProfileName}
              codeCopied={pairingCodeCopied}
              instructionsCopied={pairingInstructionsCopied}
              onOpenChange={setPairingCodeModalOpen}
              onProfileNameChange={(value) => {
                setExternalAgentProfileName(value);
                setPairingInstructionsCopied(false);
              }}
              onCopyCode={copyPairingCode}
              onCopyInstructions={copyExternalAgentSetupInstructions}
            />
            <ExternalAgentProjectGrantsDialog
              open={editProjectsModalOpen}
              agent={editingExternalAgent}
              projectIds={editingExternalAgentProjectIds}
              projects={companyProjects}
              onOpenChange={setEditProjectsModalOpen}
              onProjectIdsChange={setEditingExternalAgentProjectIds}
              onSave={saveExternalAgentProjects}
            />
          </div>
        ) : null}

        {isCompanies ? (
          <CompaniesSection
            companies={companies}
            users={users}
            pendingAction={pendingAction}
            onChangeMembership={(companyId, userId, add) =>
              void changeMembership(companyId, userId, add)
            }
            onClearPendingAction={() => setPendingAction("")}
          />
        ) : null}

        {!isAgents && !isCompanies && currentCompany ? <CompanyInvitations companyId={currentCompany.id} invitations={invitations} open={inviteOpen} onOpenChange={setInviteOpen} onSaved={reload} /> : null}

        {error ? (
          <div className="px-4 py-3 text-xs text-destructive">
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        ) : null}
      </SettingsContent>
    </SettingsLayout>
  );
}
