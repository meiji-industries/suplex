import { CompactCard } from "../../components/app/compact-card.js";
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

export function ProjectCards({ projects, agents }: { projects: readonly ApiProject[]; agents: readonly ApiProfile[] }): ReactElement {
  return <ul aria-label="Projects" className="grid min-w-0 gap-2 sm:grid-cols-2">
    {projects.map((project) => (
      <li key={project.id} className="min-w-0">
        <CompactCard highlighted href={withCompany(`/projects/${encodeURIComponent(project.id)}`, project.companyId)}>
          <ProjectIcon project={project} />
          <div className="grid min-w-0 flex-1 gap-1.5 text-xs">
            <span className="truncate text-sm font-medium">{project.name}</span>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 font-medium text-[14px] leading-[20px]" title={project.repository}>{project.repository ? <ToolIcon tool="gh-auth" /> : null}<span className="min-w-0 truncate">{project.repository ?? "Repository unavailable"}</span><Badge variant="outline">{project.baseBranch}</Badge></div>
              <div className="truncate text-muted-foreground text-[13px] leading-[18px]" title={project.repositoryPath}>{project.repositoryPath}</div>
            </div>
            <ProjectDefaultAgents project={project} agents={agents} />
          </div>
        </CompactCard>
      </li>
    ))}
  </ul>;
}
