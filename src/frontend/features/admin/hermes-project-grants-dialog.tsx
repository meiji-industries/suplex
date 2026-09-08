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
import { Field, FieldGroup, FieldLabel } from "../../components/ui/field.js";
import type { ApiHermesAgent, ApiProject } from "../../shell/view-shared.js";
import type { Dispatch, ReactElement, SetStateAction } from "react";

export function HermesProjectGrantsDialog({
  open,
  agent,
  projectIds,
  projects,
  onOpenChange,
  onProjectIdsChange,
  onSave,
}: {
  open: boolean;
  agent: ApiHermesAgent | null;
  projectIds: string[];
  projects: ApiProject[];
  onOpenChange: (open: boolean) => void;
  onProjectIdsChange: Dispatch<SetStateAction<string[]>>;
  onSave: () => Promise<void>;
}): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit allowed projects</DialogTitle>
          <DialogDescription>
            Manage project access grants for {agent?.name}.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSave();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel>Projects</FieldLabel>
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
              </div>
            </Field>
            <DialogFooter>
              <DialogClose
                render={<Button type="button" variant="outline" size="sm" />}
              >
                Cancel
              </DialogClose>
              <Button type="submit" size="sm">
                Save the project access
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
