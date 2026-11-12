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
    const admin = context.user?.role === "admin";
    return <div className="px-3 pt-3 lg:px-6"><Alert>
      <AlertTitle>The Team plan ended</AlertTitle>
      <AlertDescription>All work is read-only. Suplex keeps all work. {admin ? "Select the Team plan again to edit work." : "An administrator must select the Team plan again."}</AlertDescription>
      {admin && !window.suplexMobile ? <AlertAction><Button size="sm" nativeButton={false} render={<a href={billingSettingsPath(company.id)} />}>Open billing</Button></AlertAction> : null}
    </Alert></div>;
  }
  return <div className="px-3 pt-3 lg:px-6"><Alert><AlertDescription>You can read work in {company.name}. An administrator gives edit access.</AlertDescription></Alert></div>;
}
