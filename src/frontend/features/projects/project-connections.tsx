import type { ReactElement, ReactNode } from "react";
import type { ProjectIntegration } from "../../contracts/project-integration.js";
import { Field, FieldLabel, FieldSet } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { SettingRow, SettingsSection } from "../settings/settings-layout.js";
import { ToolIcon } from "../../components/app/tool-icons.js";

type ConnectionRow = { id: string; label: string; control: ReactNode };

export const REPOSITORY_HOSTS = [{ kind: "github", label: "GitHub" }, { kind: "bitbucket", label: "Bitbucket Cloud" }] as const;
const ISSUE_TRACKERS = [
  { kind: "none", label: "None", icon: null, connection: null },
  { kind: "github", label: "GitHub Issues", icon: "gh-auth", connection: { kind: "github" as const, repository: "" } },
  { kind: "jira", label: "Jira Cloud", icon: "jira", connection: { kind: "jira" as const, site: "https://example.atlassian.net", project: "APP", emailEnvironment: "JIRA_EMAIL", tokenEnvironment: "JIRA_TOKEN" } },
  { kind: "linear", label: "Linear", icon: "linear", connection: { kind: "linear" as const, team: "ENG", tokenEnvironment: "LINEAR_API_KEY" } },
] as const;

export function withRepositoryHost(value: ProjectIntegration, kind: string): ProjectIntegration {
  return { ...value, repository: kind === "bitbucket" ? { kind: "bitbucket", tokenEnvironment: "BITBUCKET_TOKEN" } : { kind: "github" } };
}

function RepositoryHostSelect({ value, onChange, disabled = false, id }: { value: ProjectIntegration; onChange: (value: ProjectIntegration) => void; disabled?: boolean; id?: string }): ReactElement {
  return <Select disabled={disabled} value={value.repository.kind} onValueChange={kind => onChange(withRepositoryHost(value, String(kind)))}><SelectTrigger id={id} aria-label="Repository host"><SelectValue /></SelectTrigger><SelectContent>{REPOSITORY_HOSTS.map(host => <SelectItem key={host.kind} value={host.kind}><ToolIcon tool={host.kind === "github" ? "gh-auth" : "bitbucket"} />{host.label}</SelectItem>)}</SelectContent></Select>;
}

export function ProjectConnections({ value, onChange, disabled = false, layout = "fields", repositoryHost = true }: { value: ProjectIntegration; onChange: (value: ProjectIntegration) => void; disabled?: boolean; layout?: "fields" | "settings"; repositoryHost?: boolean }): ReactElement {
  const repository = value.repository;
  const tracker = value.tracker;
  const rows: ConnectionRow[] = [
    ...(repositoryHost ? [{ id: "repository-host", label: "Repository host", control: <RepositoryHostSelect id="repository-host" disabled={disabled} value={value} onChange={onChange} /> }] : []),
    ...(repository.kind === "bitbucket" ? [
      { id: "bitbucket-token", label: "Token environment variable", control: <Input id="bitbucket-token" disabled={disabled} value={repository.tokenEnvironment} onChange={event => onChange({ ...value, repository: { ...repository, tokenEnvironment: event.target.value } })} /> },
      { id: "bitbucket-user", label: "Email environment variable (optional)", control: <Input id="bitbucket-user" disabled={disabled} value={repository.usernameEnvironment ?? ""} onChange={event => onChange({ ...value, repository: { kind: "bitbucket", tokenEnvironment: repository.tokenEnvironment, ...(event.target.value ? { usernameEnvironment: event.target.value } : {}) } })} /> },
    ] : []),
    { id: "issue-tracker", label: "Issue tracker", control: <Select disabled={disabled} value={tracker?.kind ?? "none"} onValueChange={kind => onChange({ ...value, tracker: ISSUE_TRACKERS.find(option => option.kind === kind)?.connection ?? null })}><SelectTrigger id="issue-tracker"><SelectValue /></SelectTrigger><SelectContent>{ISSUE_TRACKERS.map(option => <SelectItem key={option.kind} value={option.kind}>{option.icon ? <ToolIcon tool={option.icon} /> : null}{option.label}</SelectItem>)}</SelectContent></Select> },
    ...(tracker?.kind === "github" ? [{ id: "issue-repository", label: "Issue repository", control: <Input id="issue-repository" disabled={disabled} placeholder="owner/repository" value={tracker.repository} onChange={event => onChange({ ...value, tracker: { ...tracker, repository: event.target.value } })} /> }] : []),
    ...(tracker?.kind === "jira" ? ([ ["site", "Jira site"], ["project", "Jira project key"], ["emailEnvironment", "Email environment variable"], ["tokenEnvironment", "Token environment variable"] ] as const).map(([key, label]) => ({ id: `jira-${key}`, label, control: <Input id={`jira-${key}`} disabled={disabled} value={tracker[key]} onChange={event => onChange({ ...value, tracker: { ...tracker, [key]: event.target.value } })} /> })) : []),
    ...(tracker?.kind === "linear" ? ([ ["team", "Linear team key"], ["tokenEnvironment", "API key environment variable"] ] as const).map(([key, label]) => ({ id: `linear-${key}`, label, control: <Input id={`linear-${key}`} disabled={disabled} value={tracker[key]} onChange={event => onChange({ ...value, tracker: { ...tracker, [key]: event.target.value } })} /> })) : []),
  ];
  if (layout === "settings") return <SettingsSection title="Connections">{rows.map((row) => <SettingRow key={row.id} label={row.label} htmlFor={row.id}><div className="w-full sm:w-80">{row.control}</div></SettingRow>)}</SettingsSection>;
  return <FieldSet disabled={disabled}>{rows.map((row) => <Field key={row.id}><FieldLabel htmlFor={row.id}>{row.label}</FieldLabel>{row.control}</Field>)}</FieldSet>;
}
