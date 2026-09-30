import { Button } from "../../components/ui/button.js";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "../../components/ui/card.js";
import { EntityAvatar } from "../../components/app/entity-avatar.js";
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
  return <>
    {projects.map((project) => (
      <article key={project.id}>
        <Card className="pt-[20px]" size="sm">
          <CardHeader>
            <CardTitle><a className="flex items-center gap-2" href={withCompany(`/projects/${encodeURIComponent(project.id)}`, project.companyId)}><ProjectIcon project={project} /><span className="text-sm">{project.name}</span></a></CardTitle>
            <CardAction>
              <Button variant="ghost" size="sm" render={<a href={withCompany(`/projects/${encodeURIComponent(project.id)}`, project.companyId)} />}>Configure</Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 text-xs">
              <div className="min-w-0">
                <div className="truncate font-medium text-[14px] leading-[20px]" title={project.repository}>{project.repository ?? "Repository unavailable"}</div>
                <div className="truncate text-muted-foreground text-[13px] leading-[18px]" title={project.repositoryPath}>{project.repositoryPath}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>Base <span className="font-mono text-foreground">{project.baseBranch}</span></span>
              </div>
              <ProjectDefaultAgents project={project} agents={agents} />
            </div>
          </CardContent>
        </Card>
      </article>
    ))}
  </>;
}
