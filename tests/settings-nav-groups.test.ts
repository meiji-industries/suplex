import { expect, test } from "vitest";

import type { ApiUser } from "../src/frontend/lib/api.js";
import { buildSettingsGroups, type SettingsNavGroup } from "../src/frontend/features/settings/settings-nav.js";

const admin: ApiUser = { id: "user-1", displayName: "Admin", username: "admin", avatarSeed: "seed", role: "admin", status: "active", companyIds: ["company-1"] };
const member: ApiUser = { ...admin, id: "user-2", username: "member", role: "member" };

const titles = (groups: SettingsNavGroup[]): string[] => groups.map((group) => group.title);
const items = (groups: SettingsNavGroup[], title: string): string[] =>
  groups.find((group) => group.title === title)?.items.map((item) => item.label) ?? [];
const hrefs = (groups: SettingsNavGroup[]): Record<string, string> =>
  Object.fromEntries(groups.flatMap((group) => group.items.map((item) => [item.label, item.href])));

test("admin sees Company, AI, and System groups in order", () => {
  const groups = buildSettingsGroups("company-1", admin);
  expect(titles(groups)).toEqual(["Company", "AI", "System"]);
  expect(items(groups, "Company")).toEqual(["Onboarding", "Profile", "Templates", "Workspace", "Workflows", "Triggers"]);
  expect(items(groups, "AI")).toEqual(["Agents", "Models", "Providers"]);
  expect(items(groups, "System")).toEqual(["Users", "Companies", "Passkeys", "Invitations", "Environment", "Host health"]);
});

test("member sees Profile, Templates, and Host health only", () => {
  const groups = buildSettingsGroups("company-1", member);
  expect(titles(groups)).toEqual(["Company", "System"]);
  expect(items(groups, "Company")).toEqual(["Profile", "Templates"]);
  expect(items(groups, "System")).toEqual(["Host health"]);
});

test("signed-out user sees only System with Host health", () => {
  const groups = buildSettingsGroups("company-1", undefined);
  expect(titles(groups)).toEqual(["System"]);
  expect(items(groups, "System")).toEqual(["Host health"]);
});

test("items keep their existing hrefs", () => {
  expect(hrefs(buildSettingsGroups("company-1", admin))).toEqual({
    Onboarding: "/admin/onboarding?company=company-1",
    Profile: "/profile?company=company-1",
    Templates: "/templates?company=company-1",
    Workspace: "/companies/company-1/settings?company=company-1",
    Workflows: "/admin/workflows?company=company-1",
    Triggers: "/admin/triggers?company=company-1",
    Agents: "/admin/agents?company=company-1",
    Models: "/admin/models?company=company-1",
    Providers: "/admin/providers?company=company-1",
    Users: "/admin?company=company-1",
    Companies: "/admin/companies?company=company-1",
    Passkeys: "/admin/passkeys?company=company-1",
    Invitations: "/admin/invitations?company=company-1",
    Environment: "/admin/environment?company=company-1",
    "Host health": "/health?company=company-1",
  });
});
