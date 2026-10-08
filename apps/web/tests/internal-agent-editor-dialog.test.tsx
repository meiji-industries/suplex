// @vitest-environment happy-dom
import { act, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { ApiModel } from "../shell/view-shared.js";
import {
  InternalAgentDialog,
  type AgentProviderOption,
} from "../features/admin/internal-agent-editor-dialog.js";

const models = [
  {
    id: "claude-sonnet-4",
    provider: "claude-code",
    providerLabel: "Claude Code",
    providerStatus: "configured",
    displayName: "Claude Sonnet 4",
  },
  {
    id: "claude-haiku-4-5-20251001",
    provider: "claude-code",
    providerLabel: "Claude Code",
    providerStatus: "configured",
    displayName: "Claude Haiku 4.5",
  },
  {
    id: "claude-opus-4-1",
    provider: "claude-code",
    providerLabel: "Anthropic API",
    providerStatus: "configured",
    displayName: "Claude Opus 4.1",
  },
] satisfies ApiModel[];

const providerOptions = [
  {
    id: "provider:claude-code",
    label: "Claude Code",
    provider: "claude-code",
    providerInstanceId: null,
    status: "configured",
  },
  {
    id: "instance:claude-acme",
    label: "claude-acme",
    provider: "claude-code",
    providerInstanceId: "claude-acme",
    status: "configured",
  },
] satisfies AgentProviderOption[];

afterEach(async () => {
  await act(async () => {
    document.body.replaceChildren();
  });
});

test("Model picker searches model fields and accepts an unlisted model", async () => {
  const onAgentModelChange = vi.fn();
  const TestDialog = (): ReactElement => {
    const [agentModel, setAgentModel] = useState("claude-sonnet-4");
    return <InternalAgentDialog
      open
      editingAgentId={null}
      agentName="Coordinator"
      agentRole="root"
      agentAvatarSeed="seed"
      agentModel={agentModel}
      agentProvider="claude-code"
      agentReasoning="medium"
      agentPriority="default"
      agentInstanceId={null}
      models={models}
      providerOptions={providerOptions}
      onOpenChange={vi.fn()}
      onAgentNameChange={vi.fn()}
      onAgentRoleChange={vi.fn()}
      onAgentAvatarSeedChange={vi.fn()}
      onAgentModelChange={(value) => {
        onAgentModelChange(value);
        setAgentModel(value);
      }}
      onAgentProviderChange={vi.fn()}
      onAgentReasoningChange={vi.fn()}
      onAgentPriorityChange={vi.fn()}
      onAgentInstanceIdChange={vi.fn()}
      onSave={async () => undefined}
    />;
  };
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(<TestDialog />);
  });

  const input = document.body.querySelector<HTMLInputElement>("#agent-model");
  expect(input?.value).toBe("claude-sonnet-4");
  await act(async () => {
    input!.closest('[data-slot="input-group"]')!.querySelector<HTMLButtonElement>("button")!.click();
  });
  const items = Array.from(document.body.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')).map((item) => item.textContent);
  expect(items).toEqual([
    "Claude Sonnet 4Claude Code model",
    "Claude Haiku 4.5Fastest and cheapest. Good for routine edits.",
    "Claude Opus 4.1Anthropic API model",
  ]);

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "HAIKU-4-5");
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(Array.from(document.body.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')).map((item) => item.textContent)).toEqual([
    "Claude Haiku 4.5Fastest and cheapest. Good for routine edits.",
  ]);

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "opus 4.1");
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(Array.from(document.body.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')).map((item) => item.textContent)).toEqual([
    "Claude Opus 4.1Anthropic API model",
  ]);

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "anthropic api");
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(Array.from(document.body.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')).map((item) => item.textContent)).toEqual([
    "Claude Opus 4.1Anthropic API model",
  ]);

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "");
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(document.body.querySelectorAll('[data-slot="combobox-item"]')).toHaveLength(3);

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "claude-next");
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(onAgentModelChange).toHaveBeenLastCalledWith("claude-next");
});

test("Model picker preserves a custom model when the catalog changes", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (availableModels: ApiModel[]): void => {
    root.render(
      <InternalAgentDialog
        open
        editingAgentId="agent-1"
        agentName="Coordinator"
        agentRole="root"
        agentAvatarSeed="seed"
        agentModel="claude-next"
        agentProvider="claude-code"
        agentReasoning="high"
        agentPriority="priority"
        agentInstanceId={null}
        models={availableModels}
        providerOptions={providerOptions}
        onOpenChange={vi.fn()}
        onAgentNameChange={vi.fn()}
        onAgentRoleChange={vi.fn()}
        onAgentAvatarSeedChange={vi.fn()}
        onAgentModelChange={vi.fn()}
        onAgentProviderChange={vi.fn()}
        onAgentReasoningChange={vi.fn()}
        onAgentPriorityChange={vi.fn()}
        onAgentInstanceIdChange={vi.fn()}
        onSave={async () => undefined}
      />,
    );
  };

  await act(async () => render([]));
  expect(document.body.querySelector<HTMLInputElement>("#agent-model")?.value).toBe("claude-next");

  await act(async () => render(models));
  expect(document.body.querySelector<HTMLInputElement>("#agent-model")?.value).toBe("claude-next");
  expect(document.body.querySelector<HTMLInputElement>("#agent-name")?.value).toBe("Coordinator");
  expect(document.body.querySelector<HTMLButtonElement>("#agent-reasoning")?.textContent).toContain("High");
});

test("Provider lists and selects a company-scoped instance", async () => {
  const onAgentProviderChange = vi.fn();
  const onAgentInstanceIdChange = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);

  await act(async () => {
    createRoot(container).render(
      <InternalAgentDialog
        open
        editingAgentId={null}
        agentName="Coordinator"
        agentRole="root"
        agentAvatarSeed="seed"
        agentModel="claude-sonnet-4"
        agentProvider="claude-code"
        agentReasoning="medium"
        agentPriority="default"
        agentInstanceId={null}
        models={models}
        providerOptions={providerOptions}
        onOpenChange={vi.fn()}
        onAgentNameChange={vi.fn()}
        onAgentRoleChange={vi.fn()}
        onAgentAvatarSeedChange={vi.fn()}
        onAgentModelChange={vi.fn()}
        onAgentProviderChange={onAgentProviderChange}
        onAgentReasoningChange={vi.fn()}
        onAgentPriorityChange={vi.fn()}
        onAgentInstanceIdChange={onAgentInstanceIdChange}
        onSave={async () => undefined}
      />,
    );
  });

  const provider = document.body.querySelector<HTMLButtonElement>("#agent-provider");
  expect(provider).not.toBeNull();
  await act(async () => {
    provider!.click();
  });

  const instance = Array.from(document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]')).find(
    (item) => item.textContent?.includes("claude-acme"),
  );
  expect(instance).not.toBeUndefined();
  await act(async () => {
    instance!.click();
  });

  expect(onAgentProviderChange).toHaveBeenCalledWith("claude-code");
  expect(onAgentInstanceIdChange).toHaveBeenCalledWith("claude-acme");
});
