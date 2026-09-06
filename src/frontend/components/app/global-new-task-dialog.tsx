import { useEffect, useState } from "react";
import { withCompany } from "../../lib/api.js";
import { navigate } from "../../lib/navigation.js";
import { useOptionalCompanyContext } from "./company-context.js";
import { NewTaskDialog } from "./new-task-dialog.js";

export function requestNewTask(): void {
  window.dispatchEvent(new Event("forge:new-task"));
}

export function GlobalNewTaskDialog() {
  const company = useOptionalCompanyContext()?.currentCompany;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
    const show = () => { if (company?.status === "active") setOpen(true); };
    window.addEventListener("forge:new-task", show);
    return () => window.removeEventListener("forge:new-task", show);
  }, [company?.id, company?.status]);
  if (!company) return null;
  return <NewTaskDialog key={company.id} open={open} onOpenChange={setOpen} companyId={company.id} onCreated={task => {
    setOpen(false);
    navigate(withCompany(`/tasks/${task.id}`, task.companyId));
  }} />;
}
