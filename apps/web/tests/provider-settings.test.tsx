// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ readJsonUnchecked: vi.fn(), withCompany: (path: string) => path }));
vi.mock("../lib/api.js", () => api);
vi.mock("../shell/company-context.js", () => ({ useCompanyContext: () => ({ currentCompany: { id: "company-1", status: "active" } }) }));
vi.mock("../features/settings/settings-layout.js", () => ({ SettingsLayout: ({ children }: { children: ReactNode }) => children, SettingsContent: ({ actions, children }: { actions?: ReactNode; children: ReactNode }) => <>{actions}{children}</> }));
vi.mock("../features/tasks/task-chat/live-pane-terminal.js", () => ({ PaneTerminal: (props: { path: string; paneId: string; label: string }) => <div data-pane-terminal={props.path} data-pane-id={props.paneId} aria-label={props.label} /> }));

import { ProviderSettingsView } from "../features/settings/provider-settings.js";

const providersResponse = {
  directory: "/host", observedAt: "2026-09-13T00:00:00.000Z",
  providers: [
    { id: "claude-code", label: "Claude Code", modelCount: 3, models: [], status: "configured", connection: { status: "not-connected", summary: "Not signed in" } },
    { id: "devin", label: "Devin CLI", modelCount: 2, models: [], status: "configured", connection: { status: "connected", summary: "Signed in" } },
  ],
};
const instance = { id: "instance_1", provider: "claude-code", label: "Work laptop", homeDirectory: "/home/instance_1", createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z", readiness: { status: "unhealthy", summary: "Not signed in" }, connection: { status: "not-connected", summary: "Not signed in" } };

function mockReads(overrides: { providers?: typeof providersResponse; instances?: typeof instance[] } = {}) {
  api.readJsonUnchecked.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && url.endsWith("/login")) return { paneId: "pane-9" };
    if (init?.method === "POST" && url === "/api/admin/provider-instances") return { id: "instance_new" };
    if (init?.method === "DELETE") return {};
    if (url === "/api/admin/providers") return overrides.providers ?? providersResponse;
    if (url === "/api/admin/provider-instances") return { instances: overrides.instances ?? [instance] };
    return {};
  });
}

beforeEach(() => { vi.useFakeTimers(); api.readJsonUnchecked.mockReset(); });
afterEach(async () => { vi.useRealTimers(); await act(async () => { document.body.replaceChildren(); }); });

test("one table lists system providers and company instances with sign-in status", async () => {
  mockReads();
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => { createRoot(container).render(<ProviderSettingsView />); });

  expect(container.querySelectorAll("table")).toHaveLength(1);
  const text = container.textContent ?? "";
  expect(text).toContain("Claude Code");
  expect(text).toContain("Work laptop");
  expect(text).toContain("System");
  expect(text).toContain("Company");
  expect(text).toContain("Connected");
  expect(text).toContain("Not Connected");
  expect(text).not.toContain("OpenCode, Claude Code, and Devin CLI on the Suplex host");
  expect(text).not.toContain("New instance");
  expect(text).not.toContain("Local instances");
  expect(text).not.toContain("CLAUDE_CONFIG_DIR");
  expect(text).toContain("Add Provider");

  const logins = Array.from(container.querySelectorAll("button")).filter(button => button.textContent === "Login");
  expect(logins).toHaveLength(2);
  expect(container.querySelector('[aria-label="Login to Devin CLI"]')).toBeNull();
});

test("sign in opens the sticky terminal, polls status, and Done closes it", async () => {
  mockReads();
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => { createRoot(container).render(<ProviderSettingsView />); });

  const providerReads = () => api.readJsonUnchecked.mock.calls.filter(([url]) => url === "/api/admin/providers").length;
  const before = providerReads();
  const signIn = container.querySelector<HTMLButtonElement>('[aria-label="Login to Claude Code"]');
  expect(signIn).not.toBeNull();
  await act(async () => { signIn!.click(); });
  expect(api.readJsonUnchecked).toHaveBeenCalledWith("/api/admin/providers/claude-code/login", { method: "POST" });
  const terminal = container.querySelector<HTMLElement>("[data-pane-terminal]");
  expect(terminal?.dataset.paneTerminal).toBe("/api/admin/provider-login/pane-9/terminal");
  expect(terminal?.dataset.paneId).toBe("pane-9");

  await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
  expect(providerReads()).toBeGreaterThan(before);

  const done = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Done");
  expect(done).not.toBeNull();
  await act(async () => { done!.click(); });
  expect(api.readJsonUnchecked).toHaveBeenCalledWith("/api/admin/provider-login/pane-9", { method: "DELETE" });
  expect(container.querySelector("[data-pane-terminal]")).toBeNull();
});

test("starting another sign-in replaces the open terminal", async () => {
  let seq = 0;
  api.readJsonUnchecked.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && url.endsWith("/login")) return { paneId: `pane-${++seq}` };
    if (init?.method === "DELETE") return {};
    if (url === "/api/admin/providers") return providersResponse;
    if (url === "/api/admin/provider-instances") return { instances: [instance] };
    return {};
  });
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => { createRoot(container).render(<ProviderSettingsView />); });

  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Login to Claude Code"]')!.click(); });
  expect(container.querySelector<HTMLElement>("[data-pane-terminal]")?.dataset.paneId).toBe("pane-1");

  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Login to Work laptop"]')!.click(); });
  expect(api.readJsonUnchecked).toHaveBeenCalledWith("/api/admin/provider-instances/instance_1/login", { method: "POST" });
  const terminals = container.querySelectorAll<HTMLElement>("[data-pane-terminal]");
  expect(terminals).toHaveLength(1);
  expect(terminals[0]!.dataset.paneId).toBe("pane-2");
  // The server closed the first session; the page does not need a second receipt.
  expect(api.readJsonUnchecked.mock.calls.some(([url, init]) => init?.method === "DELETE" && String(url).includes("pane-1"))).toBe(false);
});

test("Add Provider creates a Claude Code instance through the dialog", async () => {
  mockReads({ instances: [] });
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => { createRoot(container).render(<ProviderSettingsView />); });

  const add = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Add Provider");
  expect(add).not.toBeNull();
  await act(async () => { add!.click(); });

  const input = document.body.querySelector<HTMLInputElement>("#provider-instance-label");
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input!, "Work laptop");
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const submit = input!.form?.querySelector<HTMLButtonElement>('button[type="submit"]');
  expect(submit).not.toBeNull();
  await act(async () => { submit!.click(); });
  expect(api.readJsonUnchecked).toHaveBeenCalledWith("/api/admin/provider-instances", { method: "POST", body: JSON.stringify({ provider: "claude-code", label: "Work laptop" }) });
});

test("a provider deletion conflict closes the dialog and shows the server error", async () => {
  mockReads();
  api.readJsonUnchecked.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "DELETE" && url === "/api/admin/provider-instances/instance_1") throw new Error("Provider instance is used by a project provider restriction.");
    if (url === "/api/admin/providers") return providersResponse;
    if (url === "/api/admin/provider-instances") return { instances: [instance] };
    return {};
  });
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => { createRoot(container).render(<ProviderSettingsView />); });

  const deleteButton = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Delete");
  expect(deleteButton).not.toBeNull();
  await act(async () => { deleteButton!.click(); });
  expect(document.body.textContent).toContain("Change agent profiles and project provider restrictions that use it first.");

  const confirm = Array.from(document.body.querySelectorAll("button")).find(button => button.textContent === "Delete instance");
  expect(confirm).not.toBeNull();
  await act(async () => { confirm!.click(); });

  expect(document.body.textContent).not.toContain("Delete Work laptop?");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Provider instance is used by a project provider restriction.");
});
