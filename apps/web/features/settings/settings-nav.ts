import { Archive, Braces, CreditCard, Building2, FileText, FolderGit2, HardDrive, KeyRound, ListChecks, Plug, ShieldCheck, SquareTerminal, UserRound, Users, Webhook, Workflow, type LucideIcon } from "lucide-react";

import { billingSettingsPath, companySettingsPath, withCompany, type ApiUser } from "../../lib/api.js";

export type SettingsNavItem = { label: string; href: string; icon: LucideIcon };

export type SettingsNavGroup = { title: string; items: SettingsNavItem[] };

export function buildSettingsGroups(companyId: string, user?: ApiUser): SettingsNavGroup[] {
  const admin = user?.role === "admin";
  const companyItems: SettingsNavItem[] = [
    { label: "Profile", href: withCompany("/profile", companyId), icon: UserRound },
    ...(admin ? [{ label: "Users", href: withCompany("/admin", companyId), icon: Users }] : []),
    { label: "Projects", href: withCompany("/projects", companyId), icon: FolderGit2 },
    ...(companyId && !globalThis.window?.suplexMobile ? [{ label: "Billing", href: billingSettingsPath(companyId), icon: CreditCard }] : []),
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
      { label: "Terminal", href: withCompany("/admin/terminal", companyId), icon: SquareTerminal },
      { label: "API & MCP", href: withCompany("/admin/api-mcp", companyId), icon: Braces },
      { label: "Workflows", href: withCompany("/admin/workflows", companyId), icon: Workflow },
      { label: "Triggers", href: withCompany("/admin/triggers", companyId), icon: Webhook },
    ] }] : []),
    { title: "System", items: [
      ...(admin ? [
        { label: "Companies", href: withCompany("/admin/companies", companyId), icon: Building2 },
        { label: "Remote Access", href: withCompany("/admin/access", companyId), icon: KeyRound },
        { label: "Environment", href: withCompany("/admin/environment", companyId), icon: HardDrive },
        { label: "Backups", href: withCompany("/admin/backups", companyId), icon: Archive },
      ] : []),
      { label: "Host health", href: withCompany("/health", companyId), icon: ShieldCheck },
    ] },
  ];
}
