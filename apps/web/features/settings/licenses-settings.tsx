import { ExternalLink } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { Button } from "../../components/ui/button.js";
import { Spinner } from "../../components/ui/spinner.js";
import { withCompany } from "../../lib/api.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { readThirdPartyNotices } from "./lib/licenses-api.js";
import { SettingsContent, SettingsLayout } from "./settings-layout.js";

export function LicensesView(): ReactElement {
  const { currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id ?? "";
  const [notices, setNotices] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    readThirdPartyNotices(controller.signal)
      .then(setNotices)
      .catch((error: unknown) => { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Suplex cannot load the third-party notices"); });
    return () => controller.abort();
  }, []);

  return <SettingsLayout title="Licenses" companyId={companyId} backHref={withCompany("/", companyId)} activeHref={withCompany("/licenses", companyId)}>
    <SettingsContent title="Licenses" description="The Elastic License 2.0 covers Suplex. Third-party software in Suplex keeps its own license." actions={<Button size="sm" variant="outline" nativeButton={false} render={<a href="https://www.elastic.co/licensing/elastic-license" target="_blank" rel="noreferrer" />}><ExternalLink />Open the Elastic License 2.0</Button>}>
      {notices === null ? <p className="px-4 text-xs text-muted-foreground" role="status">{message || <Spinner />}</p>
        : <pre className="overflow-x-auto rounded-lg border bg-card p-4 text-xs whitespace-pre-wrap">{notices}</pre>}
    </SettingsContent>
  </SettingsLayout>;
}
