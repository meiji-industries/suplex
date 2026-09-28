import type { ReactElement } from "react";
import { withCompany } from "../../lib/api.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { ExternalAgentConnectionGuide } from "../admin/external-agent-connection-guide.js";
import { SettingsContent, SettingsLayout } from "./settings-layout.js";

export function ApiMcpSettingsView(): ReactElement {
  const { currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id ?? "";
  return <SettingsLayout title="API & MCP" companyId={companyId} backHref={withCompany("/", companyId)} activeHref={withCompany("/admin/api-mcp", companyId)}>
    <SettingsContent width="wide" title="API & MCP">
      <ExternalAgentConnectionGuide />
    </SettingsContent>
  </SettingsLayout>;
}
