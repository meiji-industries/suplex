import { EntityAvatar } from "../../components/app/entity-avatar.js";
import { Button } from "../../components/ui/button.js";
import { Checkbox } from "../../components/ui/checkbox.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { NewButton } from "../../components/ui/new-button.js";
import type { ApiProject } from "../../shell/view-shared.js";
import type { Dispatch, ReactElement, SetStateAction } from "react";

export function HermesNewAgentDialog({
  open,
  name,
  error,
  projectIds,
  projects,
  avatarSeed,
  onOpenChange,
  onNameChange,
  onProjectIdsChange,
  onAvatarSeedChange,
  onCreate,
}: {
  open: boolean;
  name: string;
  error: string;
  projectIds: string[];
  projects: ApiProject[];
  avatarSeed: string;
  onOpenChange: (open: boolean) => void;
  onNameChange: (value: string) => void;
  onProjectIdsChange: Dispatch<SetStateAction<string[]>>;
  onAvatarSeedChange: (value: string) => void;
  onCreate: () => Promise<void>;
}): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Hermes agent</DialogTitle>
          <DialogDescription>
            Add an external agent that can add and track tasks.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onCreate();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel>Avatar</FieldLabel>
              <span className="flex items-center gap-3">
                <EntityAvatar
                  kind="agent"
                  id=""
                  name={name || "Hermes"}
                  seed={avatarSeed}
                  size="lg"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    onAvatarSeedChange(crypto.randomUUID().replaceAll("-", ""))
                  }
                >
                  Randomize
                </Button>
              </span>
            </Field>
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="hermes-name">Agent name</FieldLabel>
              <Input
                id="hermes-name"
                autoFocus
                aria-invalid={Boolean(error)}
                placeholder="e.g. SRE Hermes Bot"
                value={name}
                onChange={(event) => onNameChange(event.target.value)}
              />
              <FieldError>{error}</FieldError>
            </Field>
            <Field>
              <FieldLabel>Allowed projects</FieldLabel>
              <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border p-2">
                {projects.map((project) => {
                  const checked = projectIds.includes(project.id);
                  return (
                    <label
                      key={project.id}
                      className="flex cursor-pointer items-center gap-2 text-xs"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(value) => {
                          if (value)
                            onProjectIdsChange((previous) => [
                              ...previous,
                              project.id,
                            ]);
                          else
                            onProjectIdsChange((previous) =>
                              previous.filter((id) => id !== project.id),
                            );
                        }}
                      />
                      <span className="font-medium">{project.name}</span>
                      <span className="text-muted-foreground">
                        ({project.repository})
                      </span>
                    </label>
                  );
                })}
                {projects.length === 0 ? (
                  <span className="text-xs text-muted-foreground">
                    No projects found in this workspace.
                  </span>
                ) : null}
              </div>
              <FieldDescription>
                The agent can add and read tasks only in the selected projects.
              </FieldDescription>
            </Field>
            <DialogFooter>
              <DialogClose
                render={<Button type="button" variant="outline" size="sm" />}
              >
                Cancel
              </DialogClose>
              <NewButton
                type="submit"
                disabled={!name.trim() || projectIds.length === 0}
              >
                New Hermes agent
              </NewButton>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
