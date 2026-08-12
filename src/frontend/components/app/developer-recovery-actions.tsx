import { useState, type ReactElement } from "react";

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../ui/alert-dialog.js";
import { Button } from "../ui/button.js";

export type DeveloperRecoveryAction = "retry-development" | "cancel-development" | "cancel-issue" | "verify-developer-ownership";

export function DeveloperRecoveryActions({ allowedCommands, busy, isAdmin, onAction }: { allowedCommands: string[]; busy: boolean; isAdmin: boolean; onAction: (action: DeveloperRecoveryAction) => Promise<void> }): ReactElement {
  const [confirmAction, setConfirmAction] = useState<Exclude<DeveloperRecoveryAction, "verify-developer-ownership">>();
  const openConfirmation = (action: Exclude<DeveloperRecoveryAction, "verify-developer-ownership">): void => setConfirmAction(action);
  return <>
    <div className="mt-3 flex flex-wrap gap-2">
      {allowedCommands.includes("verify_developer_ownership") && isAdmin ? <Button size="sm" variant="outline" onClick={() => void onAction("verify-developer-ownership")} disabled={busy}>Recheck ownership</Button> : null}
      {allowedCommands.includes("retry_development") ? <Button size="sm" onClick={() => openConfirmation("retry-development")} disabled={busy}>Retry development</Button> : null}
      {allowedCommands.includes("cancel_development") ? <Button size="sm" variant="outline" onClick={() => openConfirmation("cancel-development")} disabled={busy}>Cancel development</Button> : null}
      {allowedCommands.includes("cancel_issue") ? <Button size="sm" variant="outline" onClick={() => openConfirmation("cancel-issue")} disabled={busy}>Cancel issue</Button> : null}
    </div>
    <AlertDialog open={confirmAction !== undefined} onOpenChange={(open) => { if (!open) setConfirmAction(undefined); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmAction === "retry-development" ? "Retry this Developer turn?" : confirmAction === "cancel-issue" ? "Cancel this issue?" : "Cancel this Developer turn?"}</AlertDialogTitle>
          <AlertDialogDescription>{confirmAction === "retry-development" ? "Forge will reconnect to the recorded worktree and retry only after the interrupted turn is no longer owned." : confirmAction === "cancel-issue" ? "Forge will preserve the worktree and only cancel the issue after confirmed Developer termination." : "Forge will ask the owned supervisor to terminate the turn and will only mark it cancelled after confirmed exit."}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep current state</AlertDialogCancel>
          <AlertDialogAction onClick={() => { const action = confirmAction; setConfirmAction(undefined); if (action) void onAction(action); }}>{confirmAction === "retry-development" ? "Confirm retry" : "Confirm cancellation"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
