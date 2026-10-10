import type { ReactElement } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert.js";
import { Button } from "../components/ui/button.js";
import { billingSettingsPath } from "../lib/api.js";
import { useOptionalCompanyContext } from "./company-context.js";

/** Tells why work in this company is read-only, and how an administrator ends that. */
export function ReadOnlyNotice(): ReactElement | null {
  const context = useOptionalCompanyContext();
  const company = context?.currentCompany;
  if (!company || company.access !== "read") return null;
  if (company.teamLapsed) {
    return <div className="px-3 pt-3 lg:px-6"><Alert>
      <AlertTitle>Team ended</AlertTitle>
      <AlertDescription>Work is read-only until an administrator selects Team again.</AlertDescription>
      {context.user?.role === "admin" && !window.suplexMobile ? <AlertAction><Button size="sm" nativeButton={false} render={<a href={billingSettingsPath(company.id)} />}>Select Team</Button></AlertAction> : null}
    </Alert></div>;
  }
  return <div className="px-3 pt-3 lg:px-6"><Alert><AlertDescription>You can read work in {company.name}. An administrator gives edit access.</AlertDescription></Alert></div>;
}
