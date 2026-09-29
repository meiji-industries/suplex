import type { ReactElement } from "react";

import type { ProjectResponse } from "../../contracts/projects.js";
import { EntityAvatar } from "./entity-avatar.js";

type ProjectLabelProject = Pick<ProjectResponse, "id" | "name">;

export function ProjectLabel({ project, fallback }: { project: ProjectLabelProject | undefined; fallback: string }): ReactElement {
  return project ? <><EntityAvatar kind="project" id={project.id} name={project.name} size="xs" /><span className="truncate">{project.name}</span></> : <span className="truncate">{fallback}</span>;
}
