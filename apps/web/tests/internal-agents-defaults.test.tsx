// @vitest-environment happy-dom
import { act, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { ProfileDefaults } from "../contracts/generated/ProfileDefaults.js";
import type { ApiProfile } from "../shell/view-shared.js";

const mocks = vi.hoisted(() => ({
  readJsonUnchecked: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../lib/api.js", () => ({ readJsonUnchecked: mocks.readJsonUnchecked }));
vi.mock("sonner", () => ({ toast: mocks.toast }));

import { InternalAgentsManager } from "../features/admin/internal-agents-manager.js";
import { readProfileDefaults } from "../features/admin/lib/agent-api.js";

function agent(id: string, name: string, role: ApiProfile["role"], archivedAt: string | null = null): ApiProfile {
  return {
    id,
    name,
    role,
    provider: "codex",
    model: "gpt-custom",
    reasoningLevel: "medium",
    serviceTier: "default",
    avatarSeed: "a".repeat(32),
    providerInstanceId: null,
    archivedAt,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const agents = [
  agent("planner", "Planner", "root"),
  agent("reviewer", "Reviewer", "root"),
  agent("builder", "Builder", "worker"),
  agent("helper", "Helper", "worker"),
  agent("retired", "Retired", "worker", "2026-02-01T00:00:00.000Z"),
];

function Harness({ initial }: { initial: ProfileDefaults }): ReactElement {
  const [defaults, setDefaults] = useState(initial);
  return <InternalAgentsManager agents={agents} defaults={defaults} onSaved={async () => setDefaults(await readProfileDefaults())} />;
}

async function render(initial: ProfileDefaults): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(<Harness initial={initial} />);
  });
}

function badges(name: string): string[] {
  const card = document.body.querySelector<HTMLElement>(`[aria-label="${name}"]`)!;
  return Array.from(card.querySelectorAll<HTMLElement>('[data-slot="badge"]'))
    .map((badge) => badge.textContent ?? "")
    .filter((text) => text.startsWith("Default"));
}

async function menuItems(name: string): Promise<string[]> {
  await act(async () => {
    document.body.querySelector<HTMLButtonElement>(`[aria-label="${name} actions"]`)!.click();
  });
  const items = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).map((item) => item.textContent ?? "");
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  return items.filter((text) => text.startsWith("Set as default"));
}

afterEach(async () => {
  vi.clearAllMocks();
  await act(async () => {
    document.body.replaceChildren();
  });
});

const initial: ProfileDefaults = { root: "planner", alt: "planner", worker: "builder" };

test("badges name each slot that the agent fills", async () => {
  await render(initial);
  expect(badges("Planner")).toEqual(["Default Coordinator", "Default Alt Coordinator"]);
  expect(badges("Builder")).toEqual(["Default Worker"]);
  expect(badges("Reviewer")).toEqual([]);
  expect(badges("Helper")).toEqual([]);
});

test("the menu offers only the open slots of the agent role", async () => {
  await render(initial);
  expect(await menuItems("Reviewer")).toEqual(["Set as default Coordinator", "Set as default Alt Coordinator"]);
  expect(await menuItems("Planner")).toEqual([]);
  expect(await menuItems("Helper")).toEqual(["Set as default Worker"]);
  expect(await menuItems("Builder")).toEqual([]);
  expect(await menuItems("Retired")).toEqual([]);
});

test("a new default shows a toast and moves the badge", async () => {
  const changed: ProfileDefaults = { ...initial, worker: "helper" };
  mocks.readJsonUnchecked.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/admin/profiles/helper/default" && init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toEqual({ slot: "worker" });
      return changed;
    }
    if (url === "/api/profiles/defaults") return changed;
    throw new Error(`Unexpected request: ${url}`);
  });
  await render(initial);
  await act(async () => {
    document.body.querySelector<HTMLButtonElement>('[aria-label="Helper actions"]')!.click();
  });
  await act(async () => {
    Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) => item.textContent === "Set as default Worker")!.click();
  });
  expect(mocks.toast.success).toHaveBeenCalledWith("Helper is now the default Worker for new projects.");
  expect(badges("Helper")).toEqual(["Default Worker"]);
  expect(badges("Builder")).toEqual([]);
});

test("a rejected change shows the server message and keeps the badge", async () => {
  mocks.readJsonUnchecked.mockImplementation(async () => {
    throw new Error("Select a Coordinator agent for the default Alt Coordinator");
  });
  await render(initial);
  await act(async () => {
    document.body.querySelector<HTMLButtonElement>('[aria-label="Reviewer actions"]')!.click();
  });
  await act(async () => {
    Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) => item.textContent === "Set as default Alt Coordinator")!.click();
  });
  expect(mocks.toast.success).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Select a Coordinator agent for the default Alt Coordinator");
  expect(badges("Planner")).toEqual(["Default Coordinator", "Default Alt Coordinator"]);
});
