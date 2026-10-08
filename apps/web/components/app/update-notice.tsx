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

  return (
    <div data-update-notice data-update-state={notice.kind} role="status" aria-live="polite" className="flex min-h-9 items-center gap-2 border-b px-4 py-1 lg:px-6">
      <span className="min-w-0 flex-1 text-xs">{notice.message}</span>
      {notice.kind !== "progress" && updateState.update?.canRestart ? <Button type="button" size="xs" onClick={() => void updateState.restart()} disabled={updateState.requesting}>Restart Suplex</Button> : null}
      <Button nativeButton={false} render={<a href={withCompany("/health#updates", companyId)} />} variant="link" size="xs">Open settings</Button>
    </div>
  );
}
