import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "../../components/ui/dialog.js";
import { Field, FieldLabel } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { adminDate } from "../../shell/view-shared.js";
import { Check, Copy } from "lucide-react";
import type { ReactElement } from "react";
import { externalAgentSetupInstructions } from "./external-agent-setup-instructions.js";

export function ExternalAgentPairingCodeDialog({
  open,
  data,
  profileName,
  codeCopied,
  instructionsCopied,
  onOpenChange,
  onProfileNameChange,
  onCopyCode,
  onCopyInstructions,
}: {
  open: boolean;
  data: { code: string; expiresAt: string; agentName: string } | null;
  profileName: string;
  codeCopied: boolean;
  instructionsCopied: boolean;
  onOpenChange: (open: boolean) => void;
  onProfileNameChange: (value: string) => void;
  onCopyCode: () => Promise<void>;
  onCopyInstructions: () => Promise<void>;
}): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label="Pairing code">
        <div className="min-w-0 space-y-3 py-2">
          <div className="space-y-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">Copy the setup instructions</p>
                <Badge variant="secondary">Recommended</Badge>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Give the instructions to the client that will use this identity.
              </p>
            </div>
            <Field>
              <FieldLabel htmlFor="externalAgent-profile-name">
                Client profile ID
              </FieldLabel>
              <Input
                id="externalAgent-profile-name"
                value={profileName}
                onChange={(event) => onProfileNameChange(event.target.value)}
              />
            </Field>
            <button
              type="button"
              className="relative w-full max-w-full cursor-pointer rounded-field border bg-muted/50 p-3 pr-10 text-left font-mono text-xs"
              aria-label="Copy setup instructions"
              onClick={() => void onCopyInstructions()}
            >
              <span className="block h-12 overflow-hidden whitespace-pre-wrap break-words">
                {externalAgentSetupInstructions(data, profileName).replaceAll(
                  "\n\n",
                  "\n",
                )}
              </span>
              <span className="absolute top-1/2 right-2 -translate-y-1/2">
                {instructionsCopied ? (
                  <Check aria-hidden="true" />
                ) : (
                  <Copy aria-hidden="true" />
                )}
              </span>
            </button>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
            or
          </div>
          <div className="space-y-2">
            <div>
              <p className="text-sm font-medium">Manual setup</p>
              <p className="text-[11px] text-muted-foreground">
                Use this single-use code to configure the client yourself.
              </p>
            </div>
            <button
              type="button"
              className="relative w-full max-w-full cursor-pointer rounded-field border bg-muted/50 p-3 pr-10 text-left font-mono text-xs"
              aria-label="Copy pairing code"
              onClick={() => void onCopyCode()}
            >
              <span className="block truncate">{data?.code}</span>
              <span className="absolute top-1/2 right-2 -translate-y-1/2">
                {codeCopied ? (
                  <Check aria-hidden="true" />
                ) : (
                  <Copy aria-hidden="true" />
                )}
              </span>
            </button>
            {data?.expiresAt ? (
              <p className="text-[11px] text-muted-foreground">
                Expires {adminDate(data.expiresAt)}
              </p>
            ) : null}
          </div>
        </div>
        {codeCopied || instructionsCopied ? (
          <span
            className="pointer-events-none fixed top-4 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-[11px] text-popover-foreground animate-in slide-in-from-top-2 duration-150"
            role="status"
            aria-live="polite"
          >
            Copied to Clipboard
          </span>
        ) : null}
        <DialogFooter>
          <DialogClose
            render={
              <Button
                type="button"
                size="sm"
                disabled={!codeCopied && !instructionsCopied}
              />
            }
          >
            {codeCopied || instructionsCopied ? "Continue" : "Copy to Continue"}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
