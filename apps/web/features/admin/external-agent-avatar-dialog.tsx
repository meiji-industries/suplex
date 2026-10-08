import { AvatarEditor } from "../../components/app/entity-avatar.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import type { ApiExternalAgent } from "../../shell/view-shared.js";
import type { ReactElement } from "react";

export function ExternalAgentAvatarDialog({
  target,
  onTargetChange,
}: {
  target: ApiExternalAgent | null;
  onTargetChange: (target: ApiExternalAgent | null) => void;
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
