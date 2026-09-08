import { AvatarEditor } from "../../components/app/entity-avatar.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import type { ApiHermesAgent } from "../../shell/view-shared.js";
import type { ReactElement } from "react";

export function HermesAvatarDialog({
  target,
  onTargetChange,
}: {
  target: ApiHermesAgent | null;
  onTargetChange: (target: ApiHermesAgent | null) => void;
}): ReactElement {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onTargetChange(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit avatar</DialogTitle>
          <DialogDescription>{target?.name}</DialogDescription>
        </DialogHeader>
        {target ? (
          <AvatarEditor
            kind="agent"
            id={target.id}
            name={target.name}
            seed={target.avatarSeed}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
