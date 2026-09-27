// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { ApiModel } from "../src/frontend/shell/view-shared.js";
import {
  InternalAgentDialog,
  type AgentProviderOption,
} from "../src/frontend/features/admin/internal-agent-editor-dialog.js";

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

test("Model picker lists every model with a hint and accepts an unlisted model", async () => {
  const onAgentModelChange = vi.fn();
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
        onAgentModelChange={onAgentModelChange}
        onAgentProviderChange={vi.fn()}
        onAgentReasoningChange={vi.fn()}
        onAgentPriorityChange={vi.fn()}
        onAgentInstanceIdChange={vi.fn()}
        onSave={async () => undefined}
      />,
    );
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
  ]);

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "claude-next");
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(onAgentModelChange).toHaveBeenLastCalledWith("claude-next");
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
