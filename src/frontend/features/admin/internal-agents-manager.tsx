import { useEffect, useState, type ReactElement } from "react";
import type { ApiProfile, ApiModel } from "../../shell/view-shared.js";
import type { ProviderInstanceSchema } from "../../../http/contracts/providers.js";
import type { z } from "zod";
import { readJson } from "../../lib/api.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { InternalAgentsSection } from "./internal-agents-section.js";
import {
  InternalAgentDialog,
  type AgentProviderOption,
} from "./internal-agent-editor-dialog.js";

export function InternalAgentsManager({ agents, onSaved }: { agents: readonly ApiProfile[]; onSaved: () => Promise<void> }): ReactElement {
  const [agentName, setAgentName] = useState("");
  const [agentRole, setAgentRole] = useState<"root" | "worker">("root");
  const [agentAvatarSeed, setAgentAvatarSeed] = useState("");
  const [agentModel, setAgentModel] = useState("gpt-5.6-sol");
  const [agentProvider, setAgentProvider] = useState<string>("codex");
  const [agentReasoning, setAgentReasoning] = useState("medium");
  const [agentPriority, setAgentPriority] = useState("default");
  const [agentInstanceId, setAgentInstanceId] = useState<string | null>(null);
  const [providerInstances, setProviderInstances] = useState<z.infer<typeof ProviderInstanceSchema>[]>([]);
  const [agentOpen, setAgentOpen] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<ApiProfile | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ApiProfile | null>(null);
  const [models, setModels] = useState<ApiModel[]>([]);
  const [error, setError] = useState("");
  const providerOptions: AgentProviderOption[] = [
    ...new Map(
      models.map((model) => [
        model.provider,
        {
          id: `provider:${model.provider}`,
          label: model.providerLabel,
          provider: model.provider,
          providerInstanceId: null,
          status: model.providerStatus,
        },
      ]),
    ).values(),
    ...providerInstances.map((instance): AgentProviderOption => ({
      id: `instance:${instance.id}`,
      label: instance.label,
      provider: instance.provider,
      providerInstanceId: instance.id,
      status: "configured",
    })),
  ];
  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    void Promise.all([
      readJson<{ models: ApiModel[] }>("/api/admin/models", options),
      readJson<{ instances: z.infer<typeof ProviderInstanceSchema>[] }>("/api/admin/provider-instances", options),
    ]).then(([modelList, instanceList]) => {
      if (controller.signal.aborted) return;
      setModels(modelList.models);
      setProviderInstances(instanceList.instances);
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Suplex cannot load the agent configuration.");
    });
    return () => controller.abort();
  }, []);
  const openNewAgent = (): void => {
    setEditingAgentId(null);
    setAgentName("");
    setAgentRole("root");
    setAgentAvatarSeed(crypto.randomUUID().replaceAll("-", ""));
    setAgentProvider("codex");
    setAgentModel("gpt-5.6-sol");
    setAgentReasoning("medium");
    setAgentPriority("default");
    setAgentInstanceId(null);
    setAgentOpen(true);
  };
  const openEditAgent = (agent: ApiProfile): void => {
    setEditingAgentId(agent.id);
    setAgentName(agent.name);
    setAgentRole(agent.role);
    setAgentAvatarSeed(agent.avatarSeed);
    setAgentProvider(agent.provider);
    setAgentModel(agent.model);
    setAgentReasoning(agent.reasoningLevel);
    setAgentPriority(agent.serviceTier);
    setAgentInstanceId(agent.providerInstanceId ?? null);
    setAgentOpen(true);
  };
  const saveAgent = async (): Promise<void> => {
    const editing = editingAgentId !== null;
    try {
      await readJson(
        editing
          ? `/api/admin/profiles/${encodeURIComponent(editingAgentId)}`
          : "/api/admin/profiles",
        {
          method: editing ? "PATCH" : "POST",
          body: JSON.stringify({
            name: agentName,
            role: agentRole,
            avatarSeed: agentAvatarSeed,
            provider: agentProvider,
            model: agentModel,
            reasoningLevel: agentReasoning,
            serviceTier: agentPriority,
            providerInstanceId: agentInstanceId,
          }),
        },
      );
      setAgentOpen(false);
      setEditingAgentId(null);
      await onSaved();
    } catch {
      setError(editing ? "Unable to update agent" : "Unable to add agent");
    }
  };
  const patchAgent = async (
    agent: ApiProfile,
    body: Record<string, unknown>,
    fallback: string,
  ): Promise<void> => {
    try {
      await readJson(`/api/admin/profiles/${encodeURIComponent(agent.id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setError("");
      await onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : fallback);
    }
  };
  const duplicateAgent = async (agent: ApiProfile): Promise<void> => {
    try {
      await readJson(
        `/api/admin/profiles/${encodeURIComponent(agent.id)}/duplicate`,
        { method: "POST", body: "{}" },
      );
      setError("");
      await onSaved();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to duplicate agent",
      );
    }
  };
  const deleteAgent = async (agent: ApiProfile): Promise<void> => {
    try {
      await readJson(`/api/admin/profiles/${encodeURIComponent(agent.id)}`, {
        method: "DELETE",
      });
      setError("");
      await onSaved();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to delete agent",
      );
    }
  };

  const sortedAgents = [...agents].sort(
    (left, right) =>
      Number(Boolean(left.archivedAt)) - Number(Boolean(right.archivedAt)),
  );
  return <>
    <InternalAgentsSection
      agents={agents}
      sortedAgents={sortedAgents}
      archiveTarget={archiveTarget}
      onArchiveTargetChange={setArchiveTarget}
      onOpenNewAgent={openNewAgent}
      onOpenEditAgent={openEditAgent}
      onPatchAgent={patchAgent}
      onDuplicateAgent={duplicateAgent}
      deleteTarget={deleteTarget}
      onDeleteTargetChange={setDeleteTarget}
      onDeleteAgent={deleteAgent}
    />
    <InternalAgentDialog
      open={agentOpen}
      editingAgentId={editingAgentId}
      agentName={agentName}
      agentRole={agentRole}
      agentAvatarSeed={agentAvatarSeed}
      agentModel={agentModel}
      agentProvider={agentProvider}
      agentReasoning={agentReasoning}
      agentPriority={agentPriority}
      agentInstanceId={agentInstanceId}
      models={models}
      providerOptions={providerOptions}
      onOpenChange={(open) => {
        setAgentOpen(open);
        if (!open) setEditingAgentId(null);
      }}
      onAgentNameChange={setAgentName}
      onAgentRoleChange={setAgentRole}
      onAgentAvatarSeedChange={setAgentAvatarSeed}
      onAgentModelChange={setAgentModel}
      onAgentProviderChange={setAgentProvider}
      onAgentReasoningChange={setAgentReasoning}
      onAgentPriorityChange={setAgentPriority}
      onAgentInstanceIdChange={setAgentInstanceId}
      onSave={saveAgent}
    />
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
  </>;
}
