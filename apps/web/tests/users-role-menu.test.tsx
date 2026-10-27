// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ApiUser } from "../lib/api.js";

const mocks = vi.hoisted(() => ({
  readJsonUnchecked: vi.fn(),
  setUserRole: vi.fn(),
  reloadCompanies: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../lib/api.js", () => ({
  readJsonUnchecked: mocks.readJsonUnchecked,
  withCompany: (path: string) => path,
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("../features/admin/company-users-api.js", () => ({
  listCompanyInvitations: async () => ({ invitations: [] }),
  setUserRole: mocks.setUserRole,
}));
vi.mock("../shell/company-context.js", () => {
  // One value per render keeps the reload effect from running again.
  const value = {
    user: { id: "admin-1", role: "admin" },
    companies: [],
    currentCompany: { id: "company-1", plan: "free", teamLapsed: false },
    loading: false,
    reloadCompanies: mocks.reloadCompanies,
    avatars: {},
  };
  return { useCompanyContext: () => value, useOptionalCompanyContext: () => value };
});
vi.mock("../features/settings/settings-layout.js", () => ({
  SettingsLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingRow: () => null,
}));
vi.mock("../features/admin/company-invitations.js", () => ({ CompanyInvitations: () => null }));

import { AdminView } from "../features/admin/admin.js";

function user(id: string, role: ApiUser["role"], status: ApiUser["status"] = "active"): ApiUser {
  return { id, displayName: `User ${id}`, username: id, avatarSeed: id, role, status, title: "", companyIds: ["company-1"], readCompanyIds: [] };
}

let users: ApiUser[] = [];

beforeEach(() => {
  mocks.readJsonUnchecked.mockImplementation(async (url: string) => {
    if (url === "/api/admin/users") return { users };
    throw new Error(`Unexpected request: ${url}`);
  });
  mocks.setUserRole.mockResolvedValue(undefined);
  mocks.reloadCompanies.mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.clearAllMocks();
  await act(async () => {
    document.body.replaceChildren();
  });
});

async function render(): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(<AdminView />);
  });
}

async function openMenu(name: string): Promise<void> {
  await act(async () => {
    document.body.querySelector<HTMLButtonElement>(`[aria-label="${name} actions"]`)!.click();
  });
}

const menuItems = (): HTMLElement[] => Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));
const menuItem = (label: string): HTMLElement => menuItems().find((item) => item.textContent === label)!;

test("a member menu offers Make admin and keeps the member actions", async () => {
  users = [user("admin-1", "admin"), user("member-1", "member")];
  await render();
  await openMenu("User member-1");
  expect(menuItems().map((item) => item.textContent)).toEqual(["Make admin", "Remove user"]);

  await act(async () => {
    menuItem("Make admin").click();
  });
  expect(mocks.setUserRole).toHaveBeenCalledWith("member-1", "admin", "company-1");
  expect(mocks.toast.success).toHaveBeenCalledWith("Suplex made User member-1 an admin.");
  // The list loads again after the change.
  expect(mocks.readJsonUnchecked.mock.calls.filter(([url]) => url === "/api/admin/users")).toHaveLength(2);
  expect(mocks.reloadCompanies).not.toHaveBeenCalled();
});

test("an admin menu offers Make member and disables it for the only active admin", async () => {
  users = [user("admin-1", "admin"), user("member-1", "member")];
  await render();
  await openMenu("User admin-1");
  expect(menuItems().map((item) => item.textContent)).toEqual(["Make member"]);
  expect(menuItem("Make member").hasAttribute("data-disabled")).toBe(true);
});

test("Make member changes another admin and refreshes the list", async () => {
  users = [user("admin-1", "admin"), user("admin-2", "admin")];
  await render();
  await openMenu("User admin-2");
  expect(menuItem("Make member").hasAttribute("data-disabled")).toBe(false);
  await act(async () => {
    menuItem("Make member").click();
  });
  expect(mocks.setUserRole).toHaveBeenCalledWith("admin-2", "member", "company-1");
  expect(mocks.toast.success).toHaveBeenCalledWith("Suplex made User admin-2 a member.");
  expect(mocks.readJsonUnchecked.mock.calls.filter(([url]) => url === "/api/admin/users")).toHaveLength(2);
});

test("a self-demotion refreshes the signed-in user", async () => {
  users = [user("admin-1", "admin"), user("admin-2", "admin")];
  await render();
  await openMenu("User admin-1");
  await act(async () => {
    menuItem("Make member").click();
  });
  expect(mocks.reloadCompanies).toHaveBeenCalledTimes(1);
});

test("a failed change shows the server message and no toast", async () => {
  users = [user("admin-1", "admin"), user("member-1", "member")];
  mocks.setUserRole.mockRejectedValue(new Error("Suplex must keep at least one admin."));
  await render();
  await openMenu("User member-1");
  await act(async () => {
    menuItem("Make admin").click();
  });
  expect(document.body.textContent).toContain("Suplex must keep at least one admin.");
  expect(mocks.toast.success).not.toHaveBeenCalled();
});
