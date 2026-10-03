import { AddCard } from "../../components/app/add-card.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card.js";
import { EntityAvatar } from "../../components/app/entity-avatar.js";
import { ToolIcon } from "../../components/app/tool-icons.js";
import { Badge } from "../../components/ui/badge.js";
import { withCompany } from "../../lib/api.js";
import type { ReactElement } from "react";
import type { ApiProfile, ApiProject } from "../../shell/view-shared.js";

const projectRoles = ["root", "worker"] as const;

function ProjectDefaultAgents({ project, agents }: { project: ApiProject; agents: readonly ApiProfile[] }): ReactElement {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1.5" aria-label="Default agents">
      {projectRoles.map((role) => {
        const agent = agents.find((candidate) => candidate.id === project[`${role}ProfileId`]);
        const label = role === "root" ? "Coordinator" : "Worker";
        return (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground" key={role} title={`${label}: ${agent?.name ?? "Unassigned"}`}>
            {agent ? <EntityAvatar kind="agent" id={agent.id} name={agent.name} seed={agent.avatarSeed} size="xs" /> : null}
            <span>{label}</span>
            <span className="text-foreground">{agent?.name ?? "Unassigned"}</span>
          </span>
        );
      })}
    </div>
  );
}

function ProjectIcon({ project }: { project: ApiProject }): ReactElement {
  return (
    <EntityAvatar kind="project" id={project.id} name={project.name} size="sm" />
  );
}

export function ProjectCards({ projects, agents, onAdd }: { projects: readonly ApiProject[]; agents: readonly ApiProfile[]; onAdd?: (() => void) | undefined }): ReactElement {
  return <ul aria-label="Projects" className="grid min-w-0 gap-3 sm:grid-cols-2">
    {projects.map((project) => (
      <li key={project.id} className="grid min-w-0">
        <a className="grid min-w-0" href={withCompany(`/projects/${encodeURIComponent(project.id)}`, project.companyId)}>
          <Card highlighted size="sm">
            <CardHeader><CardTitle><span className="flex min-w-0 items-center gap-2"><ProjectIcon project={project} /><span className="truncate">{project.name}</span></span></CardTitle></CardHeader>
            <CardContent>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 font-medium text-[14px] leading-[20px]" title={project.repository}>{project.repository ? <ToolIcon tool="gh-auth" /> : null}<span className="min-w-0 truncate">{project.repository ?? "Repository unavailable"}</span><Badge variant="outline">{project.baseBranch}</Badge></div>
              <div className="truncate text-muted-foreground text-[13px] leading-[18px]" title={project.repositoryPath}>{project.repositoryPath}</div>
            </div>
            <ProjectDefaultAgents project={project} agents={agents} />
            </CardContent>
          </Card>
        </a>
      </li>
    ))}
    {onAdd ? <li className="grid min-w-0"><AddCard label="Add Project" onClick={onAdd} /></li> : null}
  </ul>;
}
