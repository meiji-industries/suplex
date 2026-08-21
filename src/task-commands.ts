import { IssueCommandSchema, issueCommands, type IssueCommand, type IssueCommandSlug } from "./commands/registry.js";

// Derives from the registry's slug enum instead of duplicating it, so new commands don't need this list updated by hand.
export type TaskCommandEndpoint = IssueCommandSlug;

export interface TaskCommandDescriptor {
  name: IssueCommand;
  label: string;
  endpoint: TaskCommandEndpoint;
  method: "POST";
  expectedRevision: number;
  note: "required" | "none";
  idempotency: "required" | "none";
}

export function taskCommandDescriptors(commands: readonly string[], expectedRevision = 0): TaskCommandDescriptor[] {
  return commands.flatMap((raw) => {
    const parsed = IssueCommandSchema.safeParse(raw);
    if (!parsed.success) return [];
    const descriptor = issueCommands[parsed.data];
    if (descriptor.slug === null) return [];
    return [{ name: descriptor.name as IssueCommand, label: descriptor.label, endpoint: descriptor.slug as TaskCommandDescriptor["endpoint"], method: "POST" as const, expectedRevision, note: descriptor.note, idempotency: descriptor.idempotency }];
  });
}
