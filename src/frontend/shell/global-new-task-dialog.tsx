import { useEffect, useState } from "react";
import { withCompany } from "../lib/api.js";
import { navigate } from "./navigation-state.js";
import type { NewTaskDraft } from "../features/tasks/lib/duplicate-task-prefill.js";
import { useOptionalCompanyContext } from "./company-context.js";
import { NewTaskDialog } from "../features/tasks/new-task-dialog.js";

/** Opens the global New task dialog; explicit draft fields apply over the remembered general settings. */
export function requestNewTask(draft?: Partial<NewTaskDraft>): void {
  window.dispatchEvent(new CustomEvent<Partial<NewTaskDraft> | undefined>("suplex:new-task", { detail: draft }));
}

/** Opens the app home with the New task dialog. /today stays a client route, so the flag reaches the dialog. */
export const newTaskRequestPath = "/today?new-task=1";

export function GlobalNewTaskDialog() {
  const company = useOptionalCompanyContext()?.currentCompany;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Partial<NewTaskDraft> | undefined>(undefined);
  const [requested, setRequested] = useState(() => new URLSearchParams(window.location.search).has("new-task"));
  useEffect(() => {
    setOpen(false); setDraft(undefined);
    if (requested && company?.status === "active") {
      const url = new URL(window.location.href);
      url.searchParams.delete("new-task");
      window.history.replaceState(window.history.state, "", url);
      setRequested(false); setOpen(true);
    }
    const show = (event: Event) => {
      if (company?.status !== "active") return;
      setDraft(event instanceof CustomEvent && event.detail && typeof event.detail === "object" ? event.detail as Partial<NewTaskDraft> : undefined);
      setOpen(true);
    };
    window.addEventListener("suplex:new-task", show);
    return () => window.removeEventListener("suplex:new-task", show);
  }, [company?.id, company?.status]);
  if (!company) return null;
  return <NewTaskDialog key={company.id} open={open} onOpenChange={value => { setOpen(value); if (!value) setDraft(undefined); }} companyId={company.id} initialDraft={draft} onCreated={task => {
    setOpen(false); setDraft(undefined);
    navigate(withCompany(`/tasks/${task.id}`, task.companyId));
  }} />;
}
