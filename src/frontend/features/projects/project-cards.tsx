import { Button } from "../../components/ui/button.js";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "../../components/ui/card.js";
import { EntityAvatar } from "../../components/app/entity-avatar.js";
import { ProjectSettingsDialog } from "./project-settings-dialog.js";
import { useState, type ReactElement } from "react";
import type { ApiProfile, ApiProject } from "../../shell/view-shared.js";

const projectRoles = ["root", "worker"] as const;

function ProjectDefaultAgents({ project, agents }: { project: ApiProject; agents: readonly ApiProfile[] }): ReactElement {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1.5" aria-label="Default agents">
      {projectRoles.map((role) => {
        const agent = agents.find((candidate) => candidate.id === project[`${role}ProfileId`]);
        const label = role === "root" ? "Coordinator" : "Worker";
        return (
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground" key={role} title={`${label}: ${agent?.name ?? "Unassigned"}`}>
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

export function ProjectCards({ projects, agents, onSaved }: { projects: readonly ApiProject[]; agents: readonly ApiProfile[]; onSaved: () => Promise<void> }): ReactElement {
  const [settingsProject, setSettingsProject] = useState<ApiProject>();
  return <>
    {projects.map((project) => (
      <article key={project.id}>
        <Card size="sm">
          <CardHeader>
            <CardTitle><span className="flex items-center gap-2"><ProjectIcon project={project} /><span className="text-[13px]">{project.name}</span></span></CardTitle>
            <CardAction>
              <Button variant="ghost" size="sm" onClick={() => setSettingsProject(project)}>Configure</Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 text-xs">
              <div className="min-w-0">
                <div className="truncate font-medium" title={project.repository}>{project.repository ?? "Repository unavailable"}</div>
                <div className="truncate text-[11px] text-muted-foreground" title={project.repositoryPath}>{project.repositoryPath}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>Base <span className="font-mono text-foreground">{project.baseBranch}</span></span>
              </div>
              <ProjectDefaultAgents project={project} agents={agents} />
            </div>
          </CardContent>
        </Card>
      </article>
    ))}
    <ProjectSettingsDialog project={settingsProject} agents={agents} onOpenChange={() => setSettingsProject(undefined)} onSaved={onSaved} />
  </>;
}
