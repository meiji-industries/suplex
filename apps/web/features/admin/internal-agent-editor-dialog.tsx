import { RefreshCw } from "lucide-react";
import {
  AvatarEditor,
  EntityAvatar,
} from "../../components/app/entity-avatar.js";
import { Button } from "../../components/ui/button.js";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "../../components/ui/combobox.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { Field, FieldGroup, FieldLabel } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { NewButton } from "../../components/ui/new-button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.js";
import type { ApiModel } from "../../shell/view-shared.js";
import type { ReactElement } from "react";
import { modelHint } from "./model-hints.js";

const SERVICE_PRIORITIES = ["default", "priority"] as const;

const modelMatches = (model: ApiModel, query: string): boolean => {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return [model.id, model.displayName, model.providerLabel].some((value) =>
    value.toLocaleLowerCase().includes(normalizedQuery),
  );
};

export type AgentProviderOption = {
  id: string;
  label: string;
  provider: string;
  providerInstanceId: string | null;
  status: ApiModel["providerStatus"];
};

const serviceTierLabel = (_provider: string, priority: string): string =>
  priority === "priority" ? "Priority" : "Default";

export function InternalAgentDialog({
  open,
  editingAgentId,
  agentName,
  agentRole,
  agentAvatarSeed,
  agentModel,
  agentProvider,
  agentReasoning,
  agentPriority,
  agentInstanceId,
  models,
  providerOptions,
  onOpenChange,
  onAgentNameChange,
  onAgentRoleChange,
  onAgentAvatarSeedChange,
  onAgentModelChange,
  onAgentProviderChange,
  onAgentReasoningChange,
  onAgentPriorityChange,
  onAgentInstanceIdChange,
  onSave,
}: {
  open: boolean;
  editingAgentId: string | null;
  agentName: string;
  agentRole: "root" | "worker";
  agentAvatarSeed: string;
  agentModel: string;
  agentProvider: string;
  agentReasoning: string;
  agentPriority: string;
  agentInstanceId: string | null;
  models: ApiModel[];
  providerOptions: AgentProviderOption[];
  onOpenChange: (open: boolean) => void;
  onAgentNameChange: (value: string) => void;
  onAgentRoleChange: (value: "root" | "worker") => void;
  onAgentAvatarSeedChange: (value: string) => void;
  onAgentModelChange: (value: string) => void;
  onAgentProviderChange: (value: string) => void;
  onAgentReasoningChange: (value: string) => void;
  onAgentPriorityChange: (value: string) => void;
  onAgentInstanceIdChange: (value: string | null) => void;
  onSave: () => Promise<void>;
}): ReactElement {
  const providerModels = models.filter(
    (model) => model.provider === agentProvider,
  );
  const selectedProviderOption = providerOptions.find(
    (option) =>
      option.provider === agentProvider &&
      option.providerInstanceId === agentInstanceId,
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editingAgentId ? "Edit agent" : "Add agent"}
          </DialogTitle>
          <DialogDescription>
            Set the role and execution settings for this agent.
          </DialogDescription>
        </DialogHeader>
        <form
          className="max-h-[calc(100dvh-12rem)] overflow-y-auto"
          onSubmit={(event) => {
            event.preventDefault();
            void onSave();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel>Avatar</FieldLabel>
              <span className="flex flex-wrap items-center gap-2">
                {editingAgentId ? (
                  <AvatarEditor
                    kind="agent"
                    id={editingAgentId}
                    name={agentName || "Agent"}
                    seed={agentAvatarSeed}
                  />
                ) : (
                  <EntityAvatar
                    kind="agent"
                    id=""
                    name={agentName || "Agent"}
                    seed={agentAvatarSeed}
                    size="lg"
                  />
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Regenerate avatar"
                  title="Regenerate avatar"
                  onClick={() =>
                    onAgentAvatarSeedChange(
                      crypto.randomUUID().replaceAll("-", ""),
                    )
                  }
                >
                  <RefreshCw aria-hidden="true" />
                </Button>
              </span>
            </Field>
            {/* The six fields below sit two to a row. */}
            <div className="grid gap-x-4 gap-y-7 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="agent-name">Agent name</FieldLabel>
                <Input
                  id="agent-name"
                  autoFocus
                  value={agentName}
                  onChange={(event) => onAgentNameChange(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="agent-role">Role</FieldLabel>
                <Select
                  value={agentRole}
                  onValueChange={(value) =>
                    onAgentRoleChange(value === "worker" ? "worker" : "root")
                  }
                >
                  <SelectTrigger id="agent-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="root">Coordinator</SelectItem>
                    <SelectItem value="worker">Worker</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="agent-provider">Provider</FieldLabel>
                <Select
                  value={selectedProviderOption?.id ?? null}
                  onValueChange={(value) => {
                    const option = providerOptions.find((item) => item.id === value);
                    if (!option) return;
                    onAgentProviderChange(option.provider);
                    onAgentInstanceIdChange(option.providerInstanceId);
                    if (
                      !models.some(
                        (model) =>
                          model.provider === option.provider && model.id === agentModel,
                      )
                    )
                      onAgentModelChange("");
                  }}
                >
                  <SelectTrigger id="agent-provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {providerOptions.map(({ id, label, status }) => (
                      <SelectItem key={id} value={id} disabled={status === "missing"}>
                        {status === "missing" ? `${label} (Missing)` : label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="agent-model">Model</FieldLabel>
                {/* Free text: the provider CLI accepts models that Suplex does not list yet. */}
                <Combobox
                  items={providerModels}
                  itemToStringLabel={(model: ApiModel) => model.id}
                  value={providerModels.find((model) => model.id === agentModel) ?? null}
                  onValueChange={(model: ApiModel | null) => {
                    if (model) onAgentModelChange(model.id);
                  }}
                  inputValue={agentModel}
                  onInputValueChange={(value, details) => {
                    // Closing without a listed selection clears the input. Keep the typed model.
                    if (details.reason !== "input-clear") onAgentModelChange(value.trim());
                  }}
                  filter={modelMatches}
                >
                  <ComboboxInput
                    id="agent-model"
                    placeholder="Select or type a model"
                    autoComplete="off"
                  />
                  <ComboboxContent>
                    <ComboboxEmpty>No models listed. Type a model ID.</ComboboxEmpty>
                    <ComboboxList>
                      {(model: ApiModel) => (
                        <ComboboxItem key={model.id} value={model}>
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate">{model.displayName}</span>
                            <span className="truncate text-xs text-muted-foreground">
                              {modelHint(model.id, `${model.providerLabel} model`)}
                            </span>
                          </span>
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
              </Field>
              <Field>
                <FieldLabel htmlFor="agent-reasoning">Reasoning level</FieldLabel>
                <Select
                  value={agentReasoning}
                  onValueChange={(value) =>
                    onAgentReasoningChange(value ?? "medium")
                  }
                >
                  <SelectTrigger id="agent-reasoning">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="xhigh">XHigh</SelectItem>
                    <SelectItem value="max">Max</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="agent-priority">Service priority</FieldLabel>
                <Select
                  value={agentPriority}
                  onValueChange={(value) =>
                    onAgentPriorityChange(value ?? "default")
                  }
                >
                  <SelectTrigger id="agent-priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SERVICE_PRIORITIES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {serviceTierLabel(agentProvider, value)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <DialogFooter>
              <DialogClose
                render={<Button type="button" variant="outline" size="sm" />}
              >
                Cancel
              </DialogClose>
              {editingAgentId ? (
                <Button
                  type="submit"
                  size="sm"
                  disabled={!agentName.trim() || !agentModel}
                >
                  Save changes
                </Button>
              ) : (
                <NewButton
                  type="submit"
                  disabled={!agentName.trim() || !agentModel}
                >
                  Add agent
                </NewButton>
              )}
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
