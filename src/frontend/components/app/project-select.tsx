import type { ReactElement } from "react";

import type { ProjectResponse } from "../../contracts/projects.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.js";
import { ProjectLabel } from "./project-label.js";

/** Each project with its avatar and name. `allLabel` adds an "all" option, as a filter needs. */
export function ProjectSelect({ projects, value, onChange, id, label, allLabel, disabled = false }: {
  projects: ReadonlyArray<Pick<ProjectResponse, "id" | "name">>;
  value: string;
  onChange: (value: string) => void;
  id?: string;
  label?: string;
  allLabel?: string;
  disabled?: boolean;
}): ReactElement {
  return <Select disabled={disabled} value={value} onValueChange={next => { if (next) onChange(next); }}>
    <SelectTrigger {...(id ? { id } : {})} {...(label ? { "aria-label": label } : {})}><SelectValue>{next => allLabel && next === "all" ? allLabel : <ProjectLabel project={projects.find(project => project.id === next)} fallback="Select a project" />}</SelectValue></SelectTrigger>
    <SelectContent>
      {allLabel ? <SelectItem value="all">{allLabel}</SelectItem> : null}
      {projects.map(project => <SelectItem key={project.id} value={project.id}><ProjectLabel project={project} fallback={project.name} /></SelectItem>)}
    </SelectContent>
  </Select>;
}
