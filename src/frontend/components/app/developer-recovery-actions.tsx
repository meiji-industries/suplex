import { useState, type ReactElement } from "react";

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../ui/alert-dialog.js";
import { Button } from "../ui/button.js";

export type DeveloperRecoveryAction = "retry-development" | "cancel-development";

export function DeveloperRecoveryActions({ allowedCommands, busy, isAdmin, onAction }: { allowedCommands: string[]; busy: boolean; isAdmin: boolean; onAction: (action: DeveloperRecoveryAction) => Promise<void> }): ReactElement {
  void isAdmin;
  const [confirmAction, setConfirmAction] = useState<DeveloperRecoveryAction>();
  const [pendingAction, setPendingAction] = useState<DeveloperRecoveryAction>();
  const openConfirmation = (action: DeveloperRecoveryAction): void => setConfirmAction(action);
  const submit = async (action: DeveloperRecoveryAction): Promise<void> => {
    setPendingAction(action);
    await onAction(action).catch(() => undefined);
    setPendingAction(undefined);
  };
  return <>
    <div className="flex flex-wrap gap-2">
      {allowedCommands.includes("retry_development") ? <Button size="sm" onClick={() => openConfirmation("retry-development")} disabled={busy || pendingAction !== undefined}>Retry development</Button> : null}
      {allowedCommands.includes("cancel_development") ? <Button size="sm" variant="outline" onClick={() => openConfirmation("cancel-development")} disabled={pendingAction !== undefined}>{pendingAction === "cancel-development" ? "Cancelling development…" : "Cancel development"}</Button> : null}
    </div>
    <AlertDialog open={confirmAction !== undefined} onOpenChange={(open) => { if (!open) setConfirmAction(undefined); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
      <AlertDialogTitle>{confirmAction === "retry-development" ? "Retry this Builder turn?" : "Cancel this Builder turn?"}</AlertDialogTitle>
          <AlertDialogDescription>{confirmAction === "retry-development" ? "Forge will start a fresh Builder turn." : "Forge will terminate the recorded Builder process before continuing."}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep current state</AlertDialogCancel>
          <AlertDialogAction onClick={() => { const action = confirmAction; setConfirmAction(undefined); if (action) void submit(action); }}>{confirmAction === "retry-development" ? "Confirm retry" : "Confirm cancellation"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
