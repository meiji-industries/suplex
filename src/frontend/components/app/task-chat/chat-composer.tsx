import { TellPlannerForm } from "../tell-planner-form.js";

export function ChatComposer({ disabled, disabledReason, onSubmit }: { disabled: boolean; disabledReason?: string | undefined; onSubmit: (note: string, commandId: string) => Promise<void> }) {
  return <div className="sticky bottom-0 border-t bg-background pt-2" data-task-chat-composer><TellPlannerForm disabled={disabled} disabledReason={disabledReason} onSubmit={onSubmit} /></div>;
}
