import type { ReactElement } from "react";

import { billingSettingsPath, withCompany } from "../../lib/api.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { BillingSection } from "./billing-section.js";
import { SettingsContent, SettingsLayout } from "./settings-layout.js";

export function BillingSettingsView(): ReactElement {
  const { currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id ?? "";
  return <SettingsLayout title="Billing" companyId={companyId} backHref={withCompany("/", companyId)} activeHref={billingSettingsPath(companyId)}><SettingsContent title="Billing" description="Suplex checks project capacity before it creates a project.">{companyId ? <BillingSection key={companyId} companyId={companyId} /> : null}</SettingsContent></SettingsLayout>;
}
