import { ArrowLeft } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs.js";
import { withCompany } from "../../lib/api.js";
import { SettingsHeader, SettingsLayout, settingsColumnClassName } from "../settings/settings-layout.js";
import { isProjectSection, PROJECT_SECTIONS, type ProjectSection } from "./project-details-model.js";

type ProjectNavigation = ProjectSection | "templates";

export function ProjectDetailsLayout({ projectId, companyId, title, active, onSectionChange, children }: {
  projectId: string;
  companyId: string;
  title: string;
  active: ProjectNavigation;
  onSectionChange?: (section: ProjectSection) => void;
  children: ReactNode;
}): ReactElement {
  const projectHref = withCompany(`/projects/${encodeURIComponent(projectId)}`, companyId);
  return <SettingsLayout title={title} companyId={companyId} backHref={withCompany("/tasks", companyId)} activeHref={withCompany("/projects", companyId)}>
    <div className={settingsColumnClassName}>
      <div className="py-3">
        <a className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" href={withCompany("/projects", companyId)}><ArrowLeft className="size-3.5" />Back to projects</a>
      </div>
      <SettingsHeader title={title} />
      <Tabs value={active} onValueChange={(value) => { if (typeof value === "string" && onSectionChange && isProjectSection(value)) onSectionChange(value); }}>
        <div className="max-w-full overflow-x-auto border-b">
          <TabsList variant="line">
            {PROJECT_SECTIONS.map((section) => onSectionChange
              ? <TabsTrigger key={section.id} value={section.id}>{section.label}</TabsTrigger>
              : <TabsTrigger key={section.id} value={section.id} nativeButton={false} render={<a href={`${projectHref}#${section.id}`} />}>{section.label}</TabsTrigger>)}
            <TabsTrigger value="templates" nativeButton={false} render={<a href={withCompany(`/projects/${encodeURIComponent(projectId)}/templates`, companyId)} />}>Templates</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value={active}>{children}</TabsContent>
      </Tabs>
    </div>
  </SettingsLayout>;
}
