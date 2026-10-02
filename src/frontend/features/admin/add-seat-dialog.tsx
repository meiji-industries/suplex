import { useRef, type ReactElement } from "react";

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../components/ui/alert-dialog.js";
import { BILLING_SEAT_UNIT_AMOUNT, type HostedSeatPreview } from "../../contracts/billing.js";
import { formatUsd } from "../settings/billing-section.js";

/** A member that needs a seat before it joins a Pro company, with the quote for one more seat. */
export type SeatOffer = { companyId: string; companyName: string; userId: string; userName: string; preview: HostedSeatPreview };

export function AddSeatDialog({ offer, busy, onConfirm, onCancel }: { offer: SeatOffer | undefined; busy: boolean; onConfirm: () => void; onCancel: () => void }): ReactElement {
  // Keep the last offer on screen while the dialog closes.
  const shown = useRef(offer);
  if (offer) shown.current = offer;
  const current = shown.current;
  return (
    <AlertDialog open={offer !== undefined} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Add a seat for {current?.userName}?</AlertDialogTitle>
          <AlertDialogDescription>
            {current?.companyName} has no free seat. A seat costs {formatUsd(BILLING_SEAT_UNIT_AMOUNT)} each month. You pay {formatUsd(current?.preview.amountDueNow ?? 0)} now. Then Suplex adds {current?.userName} to the company.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={busy}>Add the seat</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
