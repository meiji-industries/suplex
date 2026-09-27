// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { ApiModel, ApiProfile } from "../src/frontend/shell/view-shared.js";

const api = vi.hoisted(() => ({ readJsonUnchecked: vi.fn() }));

vi.mock("../src/frontend/lib/api.js", () => ({
  readJsonUnchecked: api.readJsonUnchecked,
}));

import { InternalAgentsManager } from "../src/frontend/features/admin/internal-agents-manager.js";

const agent = {
  id: "agent-1",
  name: "Coordinator",
  role: "root",
  provider: "codex",
  model: "gpt-custom",
  reasoningLevel: "high",
  serviceTier: "priority",
  avatarSeed: "a".repeat(32),
  providerInstanceId: null,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} satisfies ApiProfile;

const codexModel = {
  id: "gpt-5.6-sol",
  provider: "codex",
  providerLabel: "Codex",
  providerStatus: "configured",
  displayName: "GPT-5.6 Sol",
} satisfies ApiModel;

const openCodeModel = {
  id: "openrouter/gpt-6-astra",
  provider: "opencode",
  providerLabel: "OpenCode",
  providerStatus: "configured",
  displayName: "GPT-6 Astra",
} satisfies ApiModel;

afterEach(async () => {
  api.readJsonUnchecked.mockReset();
  await act(async () => {
    document.body.replaceChildren();
  });
});

test("Agent dialog refreshes catalogs each time it opens and keeps the edited model", async () => {
  let catalogModels: ApiModel[] = [codexModel];
  api.readJsonUnchecked.mockImplementation(async (url: string) => {
    if (url === "/api/admin/models") return { models: catalogModels };
    if (url === "/api/admin/provider-instances") return { instances: [] };
    throw new Error(`Unexpected request: ${url}`);
  });

  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <InternalAgentsManager agents={[agent]} onSaved={async () => undefined} />,
    );
  });
  expect(api.readJsonUnchecked).not.toHaveBeenCalled();

  await act(async () => {
    document.body.querySelector<HTMLButtonElement>('[aria-label="Edit Coordinator"]')!.click();
  });
  expect(api.readJsonUnchecked).toHaveBeenCalledTimes(2);
  expect(document.body.querySelector<HTMLInputElement>("#agent-model")?.value).toBe("gpt-custom");

  await act(async () => {
    Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Cancel")!.click();
  });
  catalogModels = [codexModel, openCodeModel];

  await act(async () => {
    document.body.querySelector<HTMLButtonElement>('[aria-label="Edit Coordinator"]')!.click();
  });
  expect(api.readJsonUnchecked).toHaveBeenCalledTimes(4);
  expect(document.body.querySelector<HTMLInputElement>("#agent-model")?.value).toBe("gpt-custom");

  await act(async () => {
    document.body.querySelector<HTMLButtonElement>("#agent-provider")!.click();
  });
  expect(Array.from(document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]')).map((item) => item.textContent)).toContain("OpenCode");
});
