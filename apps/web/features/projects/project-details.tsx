import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { ProjectExecutionSchema } from "../../contracts/project-execution.js";
import { ProjectIntegrationSchema } from "../../contracts/project-integration.js";
import { isProfileAllowed } from "./lib/provider-policy.js";
import { HARNESS_KIND_IDS } from "../../contracts/harness-kind.js";
import type { ProjectPatchBody, ProjectProviderInstance } from "../../contracts/projects.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Checkbox } from "../../components/ui/checkbox.js";
import { FieldError } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { Spinner } from "../../components/ui/spinner.js";
import { Textarea } from "../../components/ui/textarea.js";
import { AvatarEditor, EntityAvatar } from "../../components/app/entity-avatar.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { ApiError, readJsonUnchecked, withCompany } from "../../lib/api.js";
import type { ApiProfile, ApiProject } from "../../shell/view-shared.js";
import { ProjectRepositoryConnection } from "./project-repository-connection.js";
import { ProjectConnections } from "./project-connections.js";
import { ProjectDetailsLayout } from "./project-details-layout.js";
import { updateProject } from "./lib/project-api.js";
import { taskDeliveryTargetOptions } from "../tasks/task-delivery-target.js";
import { DeliveryTargetSchema, VisualEvidenceSchema } from "../../contracts/tasks.js";
import { SettingRow, SettingsContent, SettingsSection } from "../settings/settings-layout.js";
import { LoadingState } from "../../components/app/loading-state.js";
import {
  agentsDraft,
  agentsDraftFindings,
  agentsProjectPatch,
  connectionsDraft,
  deliveryDraft,
  deliveryProjectPatch,
  executionDraft,
  executionDraftFindings,
  executionProjectPatch,
  repositoryProvides,
  generalDraft,
  generalProjectPatch,
  isProjectSection,
  type AgentsDraft,
  type ConnectionsDraft,
  type DeliveryDraft,
  type ExecutionDraft,
  type GeneralDraft,
  type ProjectSection,
} from "./project-details-model.js";

type Finding = { field: string; message: string };
type SaveStatus = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "failed"; message: string; findings: Finding[] };
type DraftState<Draft> = { saved: Draft; draft: Draft; status: SaveStatus };

const idle = { kind: "idle" } as const;
const visualEvidenceLabels = { off: "Off", capture: "Capture", required: "Necessary" } as const;
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const fieldFindings = (status: SaveStatus, ...fields: string[]): Finding[] => status.kind === "failed" ? status.findings.filter((finding) => fields.some((field) => finding.field === field || finding.field.startsWith(`${field}.`))) : [];
const sectionError = (status: SaveStatus): string => status.kind === "failed" ? status.message : "";

function draftState<Draft>(draft: Draft): DraftState<Draft> {
  return { saved: draft, draft, status: idle };
}

function saveFailure(reason: unknown, fallback: string): SaveStatus {
  return reason instanceof ApiError
    ? { kind: "failed", message: reason.message, findings: reason.findings ?? [] }
    : { kind: "failed", message: reason instanceof Error ? reason.message : fallback, findings: [] };
}

function SectionActions({ status, dirty, invalid = false, onDiscard }: { status: SaveStatus; dirty: boolean; invalid?: boolean; onDiscard: () => void }): ReactElement {
  const saving = status.kind === "saving";
  return <div className="flex items-center justify-end gap-2 border-t pt-4">
    {status.kind === "saved" ? <span className="text-xs text-muted-foreground" role="status">Saved</span> : null}
    <Button type="button" variant="outline" size="sm" disabled={saving || !dirty} onClick={onDiscard}>Discard</Button>
    <Button type="submit" size="sm" disabled={saving || !dirty || invalid}>{saving ? "Save in progress" : "Save changes"}</Button>
  </div>;
}

export function ProjectDetails({ projectId }: { projectId: string }): ReactElement {
  const { currentCompany, loading: companyLoading, reloadCompanies } = useCompanyContext();
  const companyId = currentCompany?.id ?? "";
  const [project, setProject] = useState<ApiProject>();
  const [agents, setAgents] = useState<ApiProfile[]>([]);
  const [profileError, setProfileError] = useState("");
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [providerInstances, setProviderInstances] = useState<ProjectProviderInstance[]>([]);
  const [providerInstanceError, setProviderInstanceError] = useState("");
  const [providerInstancesLoading, setProviderInstancesLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const initialSection = window.location.hash.slice(1);
  const [section, setSection] = useState<ProjectSection>(isProjectSection(initialSection) ? initialSection : "general");
  const [general, setGeneral] = useState<DraftState<GeneralDraft>>();
  const [agentSettings, setAgentSettings] = useState<DraftState<AgentsDraft>>();
  const [execution, setExecution] = useState<DraftState<ExecutionDraft>>();
  const [delivery, setDelivery] = useState<DraftState<DeliveryDraft>>();
  const [connections, setConnections] = useState<DraftState<ConnectionsDraft>>();
  const loadToken = useRef(0);
  const saveTokens = useRef<Record<ProjectSection, number>>({ general: 0, agents: 0, execution: 0, delivery: 0, connections: 0 });

  const loadProfiles = useCallback(async (generation: number): Promise<void> => {
    setProfilesLoading(true);
    setProfileError("");
    try {
      const result = await readJsonUnchecked<{ profiles: ApiProfile[] }>("/api/profiles");
      if (generation === loadToken.current) setAgents(result.profiles);
    } catch {
      if (generation === loadToken.current) setProfileError("Unable to load agents");
    } finally {
      if (generation === loadToken.current) setProfilesLoading(false);
    }
  }, []);

  const loadProviderInstances = useCallback(async (generation: number): Promise<void> => {
    setProviderInstancesLoading(true);
    setProviderInstanceError("");
    try {
      const result = await readJsonUnchecked<{ instances: ProjectProviderInstance[] }>(`/api/projects/${encodeURIComponent(projectId)}/provider-instances`);
      if (generation === loadToken.current) setProviderInstances(result.instances);
    } catch {
      if (generation === loadToken.current) setProviderInstanceError("Unable to load named provider logins");
    } finally {
      if (generation === loadToken.current) setProviderInstancesLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const token = ++loadToken.current;
    const invalidate = (): void => {
      if (loadToken.current === token) loadToken.current++;
      saveTokens.current = { general: saveTokens.current.general + 1, agents: saveTokens.current.agents + 1, execution: saveTokens.current.execution + 1, delivery: saveTokens.current.delivery + 1, connections: saveTokens.current.connections + 1 };
    };
    setProject(undefined);
    setAgents([]);
    setProfileError("");
    setProviderInstances([]);
    setProviderInstanceError("");
    setLoadError("");
    setLoading(true);
    if (!companyId || companyLoading) return invalidate;
    void loadProfiles(token);
    void loadProviderInstances(token);
    void readJsonUnchecked<ApiProject>(`/api/projects/${encodeURIComponent(projectId)}`).then((result) => {
      if (token !== loadToken.current) return;
      if (result.companyId !== companyId) {
        setLoadError("Project not found");
        return;
      }
      setProject(result);
      setGeneral(draftState(generalDraft(result)));
      setAgentSettings(draftState(agentsDraft(result)));
      setExecution(draftState(executionDraft(result)));
      setDelivery(draftState(deliveryDraft(result)));
      setConnections(draftState(connectionsDraft(result)));
    }).catch(async (reason) => {
      if (token !== loadToken.current) return;
      if (reason instanceof ApiError && reason.statusCode === 404) await reloadCompanies();
      if (token === loadToken.current) setLoadError(reason instanceof ApiError && reason.statusCode === 404 ? "Project not found" : "Unable to load the project");
    }).finally(() => { if (token === loadToken.current) setLoading(false); });
    return invalidate;
  }, [companyId, companyLoading, loadProfiles, loadProviderInstances, projectId, reloadCompanies]);

  const selectSection = useCallback((next: ProjectSection): void => {
    setSection(next);
    const url = new URL(window.location.href);
    url.hash = next === "general" ? "" : next;
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const patch = (body: ProjectPatchBody): Promise<ApiProject> => updateProject(projectId, body);

  const saveGeneral = async (): Promise<void> => {
    if (!general) return;
    const submitted = general.draft;
    const body = generalProjectPatch(general.saved, submitted);
    const token = ++saveTokens.current.general;
    const generation = loadToken.current;
    setGeneral((current) => current ? { ...current, status: { kind: "saving" } } : current);
    try {
      const result = await patch(body);
      if (token !== saveTokens.current.general || generation !== loadToken.current) return;
      const saved = generalDraft(result);
      setProject((current) => {
        if (!current) return current;
        // The response omits the repository when the project has none.
        const next = { ...current, name: result.name, repositoryPath: result.repositoryPath, baseBranch: result.baseBranch, updatedAt: result.updatedAt };
        if (result.repository === undefined) delete next.repository; else next.repository = result.repository;
        return next;
      });
      setGeneral((current) => current ? { saved, draft: same(current.draft, submitted) ? saved : current.draft, status: same(current.draft, submitted) ? { kind: "saved" } : idle } : current);
    } catch (reason) {
      if (token === saveTokens.current.general && generation === loadToken.current) setGeneral((current) => current ? { ...current, status: saveFailure(reason, "Unable to save General") } : current);
    }
  };

  const saveAgents = async (): Promise<void> => {
    if (!agentSettings) return;
    const submitted = agentSettings.draft;
    const findings = agentsDraftFindings(submitted, agents);
    if (findings.length > 0) {
      setAgentSettings((current) => current ? { ...current, status: { kind: "failed", message: "Select allowed default agents", findings } } : current);
      return;
    }
    const body = agentsProjectPatch(agentSettings.saved, submitted);
    const token = ++saveTokens.current.agents;
    const generation = loadToken.current;
    setAgentSettings((current) => current ? { ...current, status: { kind: "saving" } } : current);
    try {
      const result = await patch(body);
      if (token !== saveTokens.current.agents || generation !== loadToken.current) return;
      const saved = agentsDraft(result);
      setProject((current) => current ? { ...current, rootProfileId: result.rootProfileId, workerProfileId: result.workerProfileId, altProfileId: result.altProfileId, providerPolicy: result.providerPolicy, updatedAt: result.updatedAt } : current);
      setAgentSettings((current) => current ? { saved, draft: same(current.draft, submitted) ? saved : current.draft, status: same(current.draft, submitted) ? { kind: "saved" } : idle } : current);
    } catch (reason) {
      if (token === saveTokens.current.agents && generation === loadToken.current) setAgentSettings((current) => current ? { ...current, status: saveFailure(reason, "Unable to save Agents") } : current);
    }
  };

  const saveExecution = async (): Promise<void> => {
    if (!execution) return;
    const submitted = execution.draft;
    const findings = executionDraftFindings(submitted);
    if (findings.length > 0) {
      setExecution((current) => current ? { ...current, status: { kind: "failed", message: "Correct the execution fields", findings } } : current);
      return;
    }
    const body = executionProjectPatch(execution.saved, submitted, project?.repositorySettings);
    const token = ++saveTokens.current.execution;
    const generation = loadToken.current;
    setExecution((current) => current ? { ...current, status: { kind: "saving" } } : current);
    try {
      const result = await patch(body);
      if (token !== saveTokens.current.execution || generation !== loadToken.current) return;
      const saved = executionDraft(result);
      setProject((current) => current ? { ...current, repositorySettings: result.repositorySettings, setupCommand: result.setupCommand, verificationCommand: result.verificationCommand, execution: { ...(current.execution ?? ProjectExecutionSchema.parse({})), instructions: result.execution?.instructions ?? "", skillDirectories: result.execution?.skillDirectories ?? [] }, taskConcurrency: result.taskConcurrency, updatedAt: result.updatedAt } : current);
      setExecution((current) => current ? { saved, draft: same(current.draft, submitted) ? saved : current.draft, status: same(current.draft, submitted) ? { kind: "saved" } : idle } : current);
    } catch (reason) {
      if (token === saveTokens.current.execution && generation === loadToken.current) setExecution((current) => current ? { ...current, status: saveFailure(reason, "Unable to save Execution") } : current);
    }
  };

  const saveDelivery = async (): Promise<void> => {
    if (!delivery) return;
    const submitted = delivery.draft;
    const body = deliveryProjectPatch(delivery.saved, submitted);
    const token = ++saveTokens.current.delivery;
    const generation = loadToken.current;
    setDelivery((current) => current ? { ...current, status: { kind: "saving" } } : current);
    try {
      const result = await patch(body);
      if (token !== saveTokens.current.delivery || generation !== loadToken.current) return;
      const saved = deliveryDraft(result);
      setProject((current) => current ? { ...current, deliveryDefaults: result.deliveryDefaults, updatedAt: result.updatedAt } : current);
      setDelivery((current) => current ? { saved, draft: same(current.draft, submitted) ? saved : current.draft, status: same(current.draft, submitted) ? { kind: "saved" } : idle } : current);
    } catch (reason) {
      if (token === saveTokens.current.delivery && generation === loadToken.current) setDelivery((current) => current ? { ...current, status: saveFailure(reason, "Unable to save Delivery") } : current);
    }
  };

  const saveConnections = async (): Promise<void> => {
    if (!connections) return;
    const submitted = connections.draft;
    const localFindings: Finding[] = [];
    const integration = ProjectIntegrationSchema.safeParse(submitted.integration);
    if (!integration.success) localFindings.push(...integration.error.issues.map((issue) => ({ field: `integration.${issue.path.join(".")}`, message: issue.message })));
    let environment: unknown;
    let mcp: unknown;
    try { environment = JSON.parse(submitted.environment); } catch { localFindings.push({ field: "environment", message: "Write valid environment JSON" }); }
    try { mcp = JSON.parse(submitted.mcp); } catch { localFindings.push({ field: "mcp", message: "Write valid MCP JSON" }); }
    const executionValues = ProjectExecutionSchema.pick({ environment: true, mcp: true }).safeParse({ environment, mcp });
    if (!executionValues.success) localFindings.push(...executionValues.error.issues.map((issue) => ({ field: String(issue.path[0] ?? "connections"), message: issue.message })));
    if (!integration.success || !executionValues.success || localFindings.length > 0) {
      setConnections((current) => current ? { ...current, status: { kind: "failed", message: "Correct the connection fields", findings: localFindings } } : current);
      return;
    }
    const body: ProjectPatchBody = {
      ...(same(submitted.integration, connections.saved.integration) ? {} : { integration: integration.data }),
      ...((submitted.environment !== connections.saved.environment || submitted.mcp !== connections.saved.mcp) ? { execution: {
        ...(submitted.environment !== connections.saved.environment ? { environment: executionValues.data.environment } : {}),
        ...(submitted.mcp !== connections.saved.mcp ? { mcp: executionValues.data.mcp } : {}),
      } } : {}),
    };
    const token = ++saveTokens.current.connections;
    const generation = loadToken.current;
    setConnections((current) => current ? { ...current, status: { kind: "saving" } } : current);
    try {
      const result = await patch(body);
      if (token !== saveTokens.current.connections || generation !== loadToken.current) return;
      const saved = connectionsDraft(result);
      setProject((current) => {
        if (!current) return current;
        // The response omits the integration when the project has none.
        const next = { ...current, execution: { ...(current.execution ?? ProjectExecutionSchema.parse({})), environment: result.execution?.environment ?? {}, mcp: result.execution?.mcp ?? [] }, updatedAt: result.updatedAt };
        if (result.integration === undefined) delete next.integration; else next.integration = result.integration;
        return next;
      });
      setConnections((current) => current ? { saved, draft: same(current.draft, submitted) ? saved : current.draft, status: same(current.draft, submitted) ? { kind: "saved" } : idle } : current);
    } catch (reason) {
      if (token === saveTokens.current.connections && generation === loadToken.current) setConnections((current) => current ? { ...current, status: saveFailure(reason, "Unable to save Connections") } : current);
    }
  };

  if (loading || companyLoading) return <ProjectDetailsLayout projectId={projectId} companyId={companyId} title="Project details" active={section} onSectionChange={selectSection}><LoadingState /></ProjectDetailsLayout>;
  if (loadError || !project || !general || !agentSettings || !execution || !delivery || !connections) return <ProjectDetailsLayout projectId={projectId} companyId={companyId} title="Project details" active={section} onSectionChange={selectSection}><SettingsContent><Alert variant="destructive"><AlertDescription>{loadError || "Project not found"}</AlertDescription></Alert></SettingsContent></ProjectDetailsLayout>;

  const credentialLabel = (agent: ApiProfile): string => agent.providerInstanceId ? providerInstances.find((instance) => instance.id === agent.providerInstanceId)?.label ?? "Dedicated login" : `${agent.provider} system login`;
  const generalDirty = Object.keys(generalProjectPatch(general.saved, general.draft)).length > 0;
  const agentsDirty = Object.keys(agentsProjectPatch(agentSettings.saved, agentSettings.draft)).length > 0;
  const agentFindings = agentsDraftFindings(agentSettings.draft, agents);
  const executionDirty = Object.keys(executionProjectPatch(execution.saved, execution.draft, project.repositorySettings)).length > 0;
  const deliveryDirty = Object.keys(deliveryProjectPatch(delivery.saved, delivery.draft)).length > 0;
  const connectionsDirty = !same(connections.saved, connections.draft);
  const updateGeneral = <Key extends keyof GeneralDraft>(key: Key, value: GeneralDraft[Key]): void => setGeneral((current) => current ? { ...current, draft: { ...current.draft, [key]: value }, status: current.status.kind === "saving" ? current.status : idle } : current);
  const updateAgents = <Key extends keyof AgentsDraft>(key: Key, value: AgentsDraft[Key]): void => setAgentSettings((current) => current ? { ...current, draft: { ...current.draft, [key]: value }, status: current.status.kind === "saving" ? current.status : idle } : current);
  const updateExecution = <Key extends keyof ExecutionDraft>(key: Key, value: ExecutionDraft[Key]): void => setExecution((current) => current ? { ...current, draft: { ...current.draft, [key]: value }, status: current.status.kind === "saving" ? current.status : idle } : current);
  const updateDelivery = <Key extends keyof DeliveryDraft>(key: Key, value: DeliveryDraft[Key]): void => setDelivery((current) => current ? { ...current, draft: { ...current.draft, [key]: value }, status: current.status.kind === "saving" ? current.status : idle } : current);
  const updateConnections = <Key extends keyof ConnectionsDraft>(key: Key, value: ConnectionsDraft[Key]): void => setConnections((current) => current ? { ...current, draft: { ...current.draft, [key]: value }, status: current.status.kind === "saving" ? current.status : idle } : current);

  return <ProjectDetailsLayout projectId={project.id} companyId={project.companyId} title={project.name} active={section} onSectionChange={selectSection}>
    <SettingsContent>
      {section === "general" ? <form onSubmit={(event) => { event.preventDefault(); void saveGeneral(); }}>
        {sectionError(general.status) ? <Alert variant="destructive"><AlertDescription>{sectionError(general.status)}</AlertDescription></Alert> : null}
        <SettingsSection title="Profile">
          <SettingRow label="Project name" htmlFor="project-name"><div className="w-full sm:w-80"><Input size="sm" id="project-name" autoFocus disabled={general.status.kind === "saving"} aria-invalid={fieldFindings(general.status, "name").length > 0} value={general.draft.name} onChange={(event) => updateGeneral("name", event.target.value)} /><FieldError errors={fieldFindings(general.status, "name")} /></div></SettingRow>
          <SettingRow label="Avatar"><AvatarEditor compact kind="project" id={project.id} name={general.draft.name || project.name} /></SettingRow>
        </SettingsSection>
        <SettingsSection title="Repository">
          {project.integration?.repository.kind !== "bitbucket" ? <SettingRow label="GitHub connection"><ProjectRepositoryConnection key={JSON.stringify([project.id, project.repository, project.repositoryPath, project.baseBranch, project.updatedAt])} projectId={project.id} /></SettingRow> : null}
          <SettingRow label="Base branch" description="Default branch for new tasks." htmlFor="project-base-branch"><div className="w-full sm:w-80"><Input size="sm" id="project-base-branch" disabled={general.status.kind === "saving"} aria-invalid={fieldFindings(general.status, "baseBranch").length > 0} value={general.draft.baseBranch} onChange={(event) => updateGeneral("baseBranch", event.target.value)} /><FieldError errors={fieldFindings(general.status, "baseBranch")} /></div></SettingRow>
          <SettingRow label="Repository" description={project.integration?.repository.kind === "bitbucket" ? "Bitbucket workspace/name." : "GitHub owner/name."} htmlFor="project-repository"><div className="w-full sm:w-80"><Input size="sm" id="project-repository" disabled={general.status.kind === "saving"} value={general.draft.repository} onChange={(event) => updateGeneral("repository", event.target.value)} aria-invalid={fieldFindings(general.status, "repository").length > 0} /><FieldError errors={fieldFindings(general.status, "repository")} /></div></SettingRow>
          <SettingRow label="Repository path" description="Local checkout path. Suplex checks that its origin matches the repository." htmlFor="project-repository-path"><div className="w-full sm:w-80"><Input size="sm" id="project-repository-path" disabled={general.status.kind === "saving"} aria-invalid={fieldFindings(general.status, "repositoryPath").length > 0} value={general.draft.repositoryPath} onChange={(event) => updateGeneral("repositoryPath", event.target.value)} /><FieldError errors={fieldFindings(general.status, "repositoryPath", "repository")} /></div></SettingRow>
          <SettingRow label="Worktree root" description="Root for task worktrees."><div className="w-full sm:w-80"><code className="select-all break-all text-xs text-muted-foreground">{project.worktreeRoot}</code></div></SettingRow>
        </SettingsSection>
        <SectionActions status={general.status} dirty={generalDirty} onDiscard={() => setGeneral(draftState(general.saved))} />
      </form> : null}

      {section === "agents" ? <form onSubmit={(event) => { event.preventDefault(); void saveAgents(); }}>
        {profileError ? <Alert variant="destructive"><AlertDescription><span>{profileError}. </span><Button type="button" variant="link" size="sm" disabled={profilesLoading} onClick={() => void loadProfiles(loadToken.current)}>Retry</Button></AlertDescription></Alert> : null}
        {sectionError(agentSettings.status) ? <Alert variant="destructive"><AlertDescription>{sectionError(agentSettings.status)}</AlertDescription></Alert> : null}
        <SettingsSection title="Default agents">
          {(["rootProfileId", "altProfileId", "workerProfileId"] as const).map((key) => {
            const role = key === "workerProfileId" ? "worker" : "root";
            const selected = agents.find((agent) => agent.role === role && agent.id === agentSettings.draft[key]);
            const options = agents.filter((agent) => agent.role === role && (agent.id === agentSettings.draft[key] || isProfileAllowed(agentSettings.draft.providerPolicy, agent)));
            const findings = [...fieldFindings(agentSettings.status, key), ...agentFindings.filter((finding) => finding.field === key)];
            const id = `project-${key}`;
            return <SettingRow key={key} label={`${key === "altProfileId" ? "Alt Coordinator" : role === "root" ? "Coordinator" : "Worker"} default`} htmlFor={id}><div className="w-full sm:w-80"><Select disabled={agentSettings.status.kind === "saving"} value={agentSettings.draft[key] || null} onValueChange={(value) => { if (value) updateAgents(key, value); }}><SelectTrigger id={id} aria-invalid={findings.length > 0}><SelectValue placeholder="None">{selected ? <span className="flex items-center gap-2"><EntityAvatar kind="agent" id={selected.id} name={selected.name} seed={selected.avatarSeed} />{selected.name}</span> : "None"}</SelectValue></SelectTrigger><SelectContent>{options.map((agent) => <SelectItem key={agent.id} value={agent.id} disabled={!isProfileAllowed(agentSettings.draft.providerPolicy, agent)}><span className="flex items-center gap-2"><EntityAvatar kind="agent" id={agent.id} name={agent.name} seed={agent.avatarSeed} />{agent.name}<span className="text-xs text-muted-foreground">{credentialLabel(agent)}</span></span></SelectItem>)}</SelectContent></Select><FieldError errors={findings} /></div></SettingRow>;
          })}
          {agents.length === 0 ? <SettingRow label="Agent profiles" description="No agents are configured."><Button type="button" variant="outline" size="sm" nativeButton={false} render={<a href={withCompany("/admin/agents", project.companyId)} />}>Add an agent</Button></SettingRow> : null}
        </SettingsSection>
        <SettingsSection title="Provider access">
          <SettingRow label="Restrict providers and logins" description="Limit which providers and dedicated logins this project can use." htmlFor="project-provider-policy"><Checkbox id="project-provider-policy" disabled={agentSettings.status.kind === "saving"} checked={agentSettings.draft.providerPolicy !== null} onCheckedChange={(checked) => updateAgents("providerPolicy", checked ? { allowedProviders: [...HARNESS_KIND_IDS], allowedInstanceIds: [] } : null)} /></SettingRow>
          {agentSettings.draft.providerPolicy ? <>
            {HARNESS_KIND_IDS.map((provider) => <SettingRow key={provider} label={provider} description="System login" htmlFor={`project-provider-${provider}`}><Checkbox id={`project-provider-${provider}`} disabled={agentSettings.status.kind === "saving"} checked={agentSettings.draft.providerPolicy?.allowedProviders.includes(provider)} onCheckedChange={(checked) => { const policy = agentSettings.draft.providerPolicy; if (policy) updateAgents("providerPolicy", { ...policy, allowedProviders: checked ? [...policy.allowedProviders, provider] : policy.allowedProviders.filter((value) => value !== provider) }); }} /></SettingRow>)}
            <div className="px-4 pb-3"><FieldError errors={fieldFindings(agentSettings.status, "providerPolicy")} /></div>
          </> : null}
          {providerInstancesLoading ? <SettingRow label="Named provider logins" description="Suplex checks configured logins."><Spinner /></SettingRow> : null}
          {providerInstanceError ? <SettingRow label="Named provider logins" description={providerInstanceError}><Button type="button" variant="outline" size="sm" onClick={() => void loadProviderInstances(loadToken.current)}>Retry</Button></SettingRow> : null}
          {!providerInstancesLoading && !providerInstanceError && providerInstances.length === 0 ? <SettingRow label="Named provider logins" description="No named provider logins are configured."><span className="text-xs text-muted-foreground">None</span></SettingRow> : null}
          {!providerInstancesLoading && !providerInstanceError ? providerInstances.map((instance) => agentSettings.draft.providerPolicy
            ? <SettingRow key={instance.id} label={instance.label} description={`${instance.provider} dedicated login`} htmlFor={`project-login-${instance.id}`}><Checkbox id={`project-login-${instance.id}`} disabled={agentSettings.status.kind === "saving"} checked={agentSettings.draft.providerPolicy.allowedInstanceIds.includes(instance.id)} onCheckedChange={(checked) => { const policy = agentSettings.draft.providerPolicy; if (policy) updateAgents("providerPolicy", { ...policy, allowedInstanceIds: checked ? [...policy.allowedInstanceIds, instance.id] : policy.allowedInstanceIds.filter((value) => value !== instance.id) }); }} /></SettingRow>
            : <SettingRow key={instance.id} label={instance.label} description={`${instance.provider}. Restrictions are off.`}><span className="text-xs text-muted-foreground">Allowed</span></SettingRow>) : null}
        </SettingsSection>
        <SectionActions status={agentSettings.status} dirty={agentsDirty} invalid={agentFindings.length > 0} onDiscard={() => setAgentSettings(draftState(agentSettings.saved))} />
      </form> : null}

      {section === "execution" ? <form onSubmit={(event) => { event.preventDefault(); void saveExecution(); }}>
        {project.repositorySettings?.error ? <Alert variant="destructive"><AlertDescription>{project.repositorySettings.error}</AlertDescription></Alert> : null}
        {sectionError(execution.status) ? <Alert variant="destructive"><AlertDescription>{sectionError(execution.status)}</AlertDescription></Alert> : null}
        <SettingsSection title="Commands">
          <SettingRow label="Setup command" description={repositoryProvides(project.repositorySettings, "setup_command") ? "Provided by .suplex/settings.toml in the repository." : "Runs before task work starts."} htmlFor="project-setup-command"><div className="w-full sm:w-96"><Input size="sm" id="project-setup-command" disabled={execution.status.kind === "saving" || repositoryProvides(project.repositorySettings, "setup_command")} aria-invalid={fieldFindings(execution.status, "setupCommand").length > 0} value={execution.draft.setupCommand} onChange={(event) => updateExecution("setupCommand", event.target.value)} /><FieldError errors={fieldFindings(execution.status, "setupCommand")} /></div></SettingRow>
          <SettingRow label="Verification command" description={repositoryProvides(project.repositorySettings, "verification_command") ? "Provided by .suplex/settings.toml in the repository." : "Checks completed task work."} htmlFor="project-verification-command"><div className="w-full sm:w-96"><Input size="sm" id="project-verification-command" disabled={execution.status.kind === "saving" || repositoryProvides(project.repositorySettings, "verification_command")} aria-invalid={fieldFindings(execution.status, "verificationCommand").length > 0} value={execution.draft.verificationCommand} onChange={(event) => updateExecution("verificationCommand", event.target.value)} /><FieldError errors={fieldFindings(execution.status, "verificationCommand")} /></div></SettingRow>
        </SettingsSection>
        <SettingsSection title="Scheduling">
          <SettingRow label="Task concurrency" description={repositoryProvides(project.repositorySettings, "task_concurrency") ? "Provided by .suplex/settings.toml in the repository." : "The maximum number of tasks that Suplex runs at one time. Empty means no limit."} htmlFor="project-task-concurrency"><div className="w-full sm:w-96"><Input size="sm" id="project-task-concurrency" inputMode="numeric" disabled={execution.status.kind === "saving" || repositoryProvides(project.repositorySettings, "task_concurrency")} aria-invalid={fieldFindings(execution.status, "taskConcurrency").length > 0} value={execution.draft.taskConcurrency} onChange={(event) => updateExecution("taskConcurrency", event.target.value)} /><FieldError errors={fieldFindings(execution.status, "taskConcurrency")} /></div></SettingRow>
        </SettingsSection>
        <SettingsSection title="Agent context">
          <SettingRow label="Project instructions" description={repositoryProvides(project.repositorySettings, "instructions") ? "Provided by .suplex/settings.toml in the repository." : "Instructions added to project tasks."} htmlFor="project-instructions"><div className="w-full sm:w-[28rem]"><Textarea id="project-instructions" disabled={execution.status.kind === "saving" || repositoryProvides(project.repositorySettings, "instructions")} value={execution.draft.instructions} onChange={(event) => updateExecution("instructions", event.target.value)} /></div></SettingRow>
          <SettingRow label="Skill directories" description="One directory per line." htmlFor="project-skills"><div className="w-full sm:w-[28rem]"><Textarea id="project-skills" disabled={execution.status.kind === "saving"} value={execution.draft.skillDirectories} onChange={(event) => updateExecution("skillDirectories", event.target.value)} /></div></SettingRow>
        </SettingsSection>
        <SectionActions status={execution.status} dirty={executionDirty} onDiscard={() => setExecution(draftState(execution.saved))} />
      </form> : null}

      {section === "delivery" ? <form onSubmit={(event) => { event.preventDefault(); void saveDelivery(); }}>
        {sectionError(delivery.status) ? <Alert variant="destructive"><AlertDescription>{sectionError(delivery.status)}</AlertDescription></Alert> : null}
        <SettingsSection title="Delivery defaults" description="Agent tasks use these values when the request does not set them.">
          <SettingRow label="Delivery target" description="Where Suplex delivers the completed task." htmlFor="project-delivery-target"><div className="w-full sm:w-80"><Select disabled={delivery.status.kind === "saving"} value={delivery.draft.deliveryTarget} onValueChange={(value) => { const target = DeliveryTargetSchema.safeParse(value); if (target.success) updateDelivery("deliveryTarget", target.data); }}><SelectTrigger id="project-delivery-target" aria-invalid={fieldFindings(delivery.status, "deliveryDefaults").length > 0}><SelectValue>{taskDeliveryTargetOptions.find((option) => option.value === delivery.draft.deliveryTarget)?.label}</SelectValue></SelectTrigger><SelectContent>{taskDeliveryTargetOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select><FieldError errors={fieldFindings(delivery.status, "deliveryDefaults")} /></div></SettingRow>
          <SettingRow label="Run project tests" htmlFor="project-run-project-tests"><div className="w-full sm:w-80"><Select disabled={delivery.status.kind === "saving"} value={delivery.draft.runProjectTests ? "on" : "off"} onValueChange={(value) => updateDelivery("runProjectTests", value === "on")}><SelectTrigger id="project-run-project-tests"><SelectValue>{delivery.draft.runProjectTests ? "On" : "Off"}</SelectValue></SelectTrigger><SelectContent><SelectItem value="on">On</SelectItem><SelectItem value="off">Off</SelectItem></SelectContent></Select></div></SettingRow>
          <SettingRow label="Browser evidence" htmlFor="project-visual-evidence"><div className="w-full sm:w-80"><Select disabled={delivery.status.kind === "saving"} value={delivery.draft.visualEvidence} onValueChange={(value) => { const evidence = VisualEvidenceSchema.safeParse(value); if (evidence.success) updateDelivery("visualEvidence", evidence.data); }}><SelectTrigger id="project-visual-evidence"><SelectValue>{visualEvidenceLabels[delivery.draft.visualEvidence]}</SelectValue></SelectTrigger><SelectContent>{VisualEvidenceSchema.options.map((value) => <SelectItem key={value} value={value}>{visualEvidenceLabels[value]}</SelectItem>)}</SelectContent></Select></div></SettingRow>
        </SettingsSection>
        <SectionActions status={delivery.status} dirty={deliveryDirty} onDiscard={() => setDelivery(draftState(delivery.saved))} />
      </form> : null}

      {section === "connections" ? <form onSubmit={(event) => { event.preventDefault(); void saveConnections(); }}>
        {sectionError(connections.status) ? <Alert variant="destructive"><AlertDescription>{sectionError(connections.status)}</AlertDescription></Alert> : null}
        <ProjectConnections layout="settings" disabled={connections.status.kind === "saving"} value={connections.draft.integration} onChange={(value) => updateConnections("integration", value)} />
        <SettingsSection title="Runtime connections">
          <SettingRow label="Environment values" description="Use non-secret JSON values. Configure credential references in Connections." htmlFor="project-environment"><div className="w-full sm:w-[28rem]"><Textarea id="project-environment" disabled={connections.status.kind === "saving"} aria-invalid={fieldFindings(connections.status, "environment").length > 0} value={connections.draft.environment} onChange={(event) => updateConnections("environment", event.target.value)} /><FieldError errors={fieldFindings(connections.status, "environment")} /></div></SettingRow>
          <SettingRow label="Claude MCP servers and tool grants" description="Use environment variable names for credential references. Grant tools to each agent role." htmlFor="project-mcp"><div className="w-full sm:w-[28rem]"><Textarea id="project-mcp" disabled={connections.status.kind === "saving"} aria-invalid={fieldFindings(connections.status, "mcp").length > 0} value={connections.draft.mcp} onChange={(event) => updateConnections("mcp", event.target.value)} /><FieldError errors={fieldFindings(connections.status, "mcp")} /></div></SettingRow>
        </SettingsSection>
        <SectionActions status={connections.status} dirty={connectionsDirty} onDiscard={() => setConnections(draftState(connections.saved))} />
      </form> : null}
    </SettingsContent>
  </ProjectDetailsLayout>;
}
