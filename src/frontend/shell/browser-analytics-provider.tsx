import { useEffect, type ReactElement } from "react";

import { useCompanyContext } from "./company-context.js";
import { installBrowserAnalytics, updateBrowserAnalyticsContext } from "./browser-analytics.js";

export function BrowserAnalytics(): ReactElement | null {
  const { currentCompany } = useCompanyContext();

  useEffect(() => installBrowserAnalytics(), []);
  useEffect(() => {
    updateBrowserAnalyticsContext({
      ...(currentCompany ? { companyId: currentCompany.id } : {}),
      ...(currentCompany?.plan !== undefined ? { companyPlan: currentCompany.plan } : {}),
      platform: window.suplexApp ? "desktop" : window.suplexMobile ? "mobile" : "browser",
    });
  }, [currentCompany]);

  return null;
}
