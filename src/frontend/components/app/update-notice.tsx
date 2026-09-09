import { X } from "lucide-react";
import type { ReactElement } from "react";

import { withCompany } from "../../lib/api.js";
import { useOptionalCompanyContext } from "../../shell/company-context.js";
import { Button } from "../ui/button.js";
import { useOptionalUpdate } from "./update-provider.js";

export function UpdateNotice(): ReactElement | null {
  const companyId = useOptionalCompanyContext()?.currentCompany?.id;
  const updateState = useOptionalUpdate();
  const notice = updateState?.notice;
  if (!notice || !updateState) return null;

  const message = notice.kind === "available"
    ? "Forge update available."
    : notice.message;

  return (
    <div data-update-notice data-update-state={notice.kind} role="status" aria-live="polite" className="flex min-h-9 items-center gap-2 border-b px-4 py-1 lg:px-6">
      <span className="min-w-0 flex-1 text-xs">{message}</span>
      <Button render={<a href={withCompany("/health#updates", companyId)} />} variant="link" size="xs">Open settings</Button>
      {notice.kind === "progress" ? null : (
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Close update notice" title="Close update notice" onClick={updateState.dismissNotice}>
          <X aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
