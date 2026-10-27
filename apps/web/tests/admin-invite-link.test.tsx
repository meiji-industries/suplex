// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ readJsonUnchecked: vi.fn(), withCompany: (path: string) => path }));
vi.mock("../lib/api.js", () => api);
const context = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("../shell/company-context.js", () => ({ useCompanyContext: () => context.value }));
vi.mock("../features/admin/company-users-api.js", () => ({ listCompanyInvitations: vi.fn(async () => []) }));
vi.mock("../features/admin/company-invitations.js", () => ({
  CompanyInvitations: ({ open }: { open: boolean }) => (open ? <div role="dialog">Add User</div> : null),
}));
vi.mock("../features/admin/users-section.js", () => ({ UsersSection: () => null }));
vi.mock("../features/settings/settings-layout.js", () => ({
  SettingsLayout: ({ children }: { children: ReactNode }) => children,
  SettingsContent: ({ actions, children }: { actions?: ReactNode; children: ReactNode }) => <>{actions}{children}</>,
  SettingsSection: ({ children }: { children: ReactNode }) => children,
  SettingRow: () => null,
}));

import { AdminView } from "../features/admin/admin.js";

const admin = { id: "u1", role: "admin" };
const company = { id: "company-1", status: "active" };
let root: Root | undefined;

async function mount(): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<AdminView />); });
}

beforeEach(() => {
  api.readJsonUnchecked.mockReset();
  api.readJsonUnchecked.mockResolvedValue({ users: [], agents: [], profiles: [], externalAgents: [] });
  context.value = { user: admin, companies: [company], currentCompany: company, loading: false };
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  document.body.replaceChildren();
});

test("arriving with the invite parameter opens Add User once and clears the parameter", async () => {
  window.history.replaceState({}, "", "/admin?company=company-1&invite=1");
  await mount();
  expect(document.querySelector('[role="dialog"]')?.textContent).toBe("Add User");
  expect(window.location.search).toBe("?company=company-1");
});

test("the Users page stays closed without the invite parameter", async () => {
  window.history.replaceState({}, "", "/admin?company=company-1");
  await mount();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("a non-administrator does not open Add User", async () => {
  context.value = { ...context.value, user: { id: "u2", role: "member" } };
  window.history.replaceState({}, "", "/admin?invite=1");
  await mount();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
