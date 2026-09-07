import { useEffect, useState } from "react";
import { withCompany } from "../../lib/api.js";
import { navigate } from "../../lib/navigation.js";
import type { NewTaskDraft } from "../../lib/duplicate-task-prefill.js";
import { useOptionalCompanyContext } from "./company-context.js";
import { NewTaskDialog } from "./new-task-dialog.js";

/** Opens the global New task dialog; explicit draft fields apply over the remembered general settings. */
export function requestNewTask(draft?: Partial<NewTaskDraft>): void {
  window.dispatchEvent(new CustomEvent<Partial<NewTaskDraft> | undefined>("forge:new-task", { detail: draft }));
}

export function GlobalNewTaskDialog() {
  const company = useOptionalCompanyContext()?.currentCompany;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Partial<NewTaskDraft> | undefined>(undefined);
  useEffect(() => {
    setOpen(false); setDraft(undefined);
    const show = (event: Event) => {
      if (company?.status !== "active") return;
      setDraft(event instanceof CustomEvent && event.detail && typeof event.detail === "object" ? event.detail as Partial<NewTaskDraft> : undefined);
      setOpen(true);
    };
    window.addEventListener("forge:new-task", show);
    return () => window.removeEventListener("forge:new-task", show);
  }, [company?.id, company?.status]);
  if (!company) return null;
  return <NewTaskDialog key={company.id} open={open} onOpenChange={value => { setOpen(value); if (!value) setDraft(undefined); }} companyId={company.id} initialDraft={draft} onCreated={task => {
    setOpen(false); setDraft(undefined);
    navigate(withCompany(`/tasks/${task.id}`, task.companyId));
  }} />;
}
