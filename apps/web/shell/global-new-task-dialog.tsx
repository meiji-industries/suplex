import { useEffect, useRef, useState } from "react";
import { withCompany } from "../lib/api.js";
import { navigate } from "./navigation-state.js";
import type { NewTaskDraft } from "../features/tasks/lib/duplicate-task-prefill.js";
import { useOptionalCompanyContext } from "./company-context.js";
import { NewTaskDialog } from "../features/tasks/new-task-dialog.js";
import { listProjects } from "../features/projects/lib/project-api.js";

/** Opens the global New task dialog; explicit draft fields apply over the remembered general settings. */
export function requestNewTask(draft?: Partial<NewTaskDraft>): void {
  window.dispatchEvent(new CustomEvent<Partial<NewTaskDraft> | undefined>("suplex:new-task", { detail: draft }));
}

/** Opens the app home with the New task dialog. /today stays a client route, so the flag reaches the dialog. */
export const newTaskRequestPath = "/today?new-task=1";

const hasProjectsByCompany = new Map<string, boolean>();
const pendingProjectReads = new Map<string, Promise<boolean>>();

function readHasProjects(companyId: string): Promise<boolean> {
  let read = pendingProjectReads.get(companyId);
  if (!read) {
    read = listProjects(companyId).then(projects => { hasProjectsByCompany.set(companyId, projects.length > 0); return projects.length > 0; }).finally(() => pendingProjectReads.delete(companyId));
    pendingProjectReads.set(companyId, read);
  }
  return read;
}

/** Reads the project list on mount. Undefined until known; a failed read keeps the New task action. */
export function useHasProjects(companyId: string | undefined): boolean | undefined {
  const [hasProjects, setHasProjects] = useState(() => companyId ? hasProjectsByCompany.get(companyId) : undefined);
  useEffect(() => {
    if (!companyId) return;
    let live = true;
    setHasProjects(hasProjectsByCompany.get(companyId));
    readHasProjects(companyId).then(value => { if (live) setHasProjects(value); }, () => { if (live) setHasProjects(true); });
    return () => { live = false; };
  }, [companyId]);
  return hasProjects;
}

export function GlobalNewTaskDialog() {
  const company = useOptionalCompanyContext()?.currentCompany;
  const hasProjects = useHasProjects(company?.id);
  const hasProjectsRef = useRef(hasProjects);
  hasProjectsRef.current = hasProjects;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Partial<NewTaskDraft> | undefined>(undefined);
  const [requested, setRequested] = useState(() => new URLSearchParams(window.location.search).has("new-task"));
  useEffect(() => {
    setOpen(false); setDraft(undefined);
    const show = (event: Event) => {
      if (company?.status !== "active") return;
      if (hasProjectsRef.current === false) { navigate(withCompany("/projects", company.id)); return; }
      setDraft(event instanceof CustomEvent && event.detail && typeof event.detail === "object" ? event.detail as Partial<NewTaskDraft> : undefined);
      setOpen(true);
    };
    window.addEventListener("suplex:new-task", show);
    return () => window.removeEventListener("suplex:new-task", show);
  }, [company?.id, company?.status]);
  useEffect(() => {
    if (!requested || company?.status !== "active" || hasProjects === undefined) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("new-task");
    window.history.replaceState(window.history.state, "", url);
    setRequested(false);
    if (hasProjects) setOpen(true);
  }, [requested, company?.status, hasProjects]);
  if (!company) return null;
  return <NewTaskDialog key={company.id} open={open} onOpenChange={value => { setOpen(value); if (!value) setDraft(undefined); }} companyId={company.id} initialDraft={draft} onCreated={task => {
    setOpen(false); setDraft(undefined);
    navigate(withCompany(`/tasks/${task.id}`, task.companyId));
  }} />;
}
