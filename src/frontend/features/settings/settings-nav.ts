import { Archive, Braces, Building2, FileText, FolderGit2, HardDrive, KeyRound, ListChecks, Mail, Plug, ShieldCheck, UserRound, Users, Webhook, Workflow, type LucideIcon } from "lucide-react";

import { companySettingsPath, withCompany, type ApiUser } from "../../lib/api.js";

export type SettingsNavItem = { label: string; href: string; icon: LucideIcon };

export type SettingsNavGroup = { title: string; items: SettingsNavItem[] };

export function buildSettingsGroups(companyId: string, user?: ApiUser): SettingsNavGroup[] {
  const admin = user?.role === "admin";
  const companyItems: SettingsNavItem[] = [
    { label: "Profile", href: withCompany("/profile", companyId), icon: UserRound },
    { label: "Projects", href: withCompany("/projects", companyId), icon: FolderGit2 },
    { label: "Templates", href: withCompany("/templates", companyId), icon: FileText },
    ...(admin && companyId ? [{ label: "Workspace", href: companySettingsPath(companyId), icon: Building2 }] : []),
    ...(admin ? [
      { label: "Onboarding", href: withCompany("/admin/onboarding", companyId), icon: ListChecks },
    ] : []),
  ];
  return [
    ...(user && companyItems.length ? [{ title: "Company", items: companyItems }] : []),
    ...(admin ? [{ title: "Features", items: [
      { label: "Agents", href: withCompany("/admin/agents", companyId), icon: Users },
      { label: "Providers", href: withCompany("/admin/providers", companyId), icon: Plug },
      { label: "API & MCP", href: withCompany("/admin/api-mcp", companyId), icon: Braces },
      { label: "Workflows", href: withCompany("/admin/workflows", companyId), icon: Workflow },
      { label: "Triggers", href: withCompany("/admin/triggers", companyId), icon: Webhook },
    ] }] : []),
    { title: "System", items: [
      ...(admin ? [
        { label: "Users", href: withCompany("/admin", companyId), icon: Users },
        { label: "Companies", href: withCompany("/admin/companies", companyId), icon: Building2 },
        { label: "Passkeys", href: withCompany("/admin/passkeys", companyId), icon: KeyRound },
        { label: "Invitations", href: withCompany("/admin/invitations", companyId), icon: Mail },
        { label: "Environment", href: withCompany("/admin/environment", companyId), icon: HardDrive },
        { label: "Backups", href: withCompany("/admin/backups", companyId), icon: Archive },
      ] : []),
      { label: "Host health", href: withCompany("/health", companyId), icon: ShieldCheck },
    ] },
  ];
}
