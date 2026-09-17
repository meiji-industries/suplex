import type { ReactElement } from "react";
import type { ProjectIntegration } from "../../../projects/integration-configuration.js";
import { Field, FieldLabel, FieldSet, FieldLegend } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";

export function ProjectConnections({ value, onChange }: { value: ProjectIntegration; onChange: (value: ProjectIntegration) => void }): ReactElement {
  const repository = value.repository;
  const tracker = value.tracker;
  return <FieldSet><FieldLegend variant="label">Connections</FieldLegend>
    <Field><FieldLabel htmlFor="repository-host">Repository host</FieldLabel><Select value={repository.kind} onValueChange={kind => onChange({ ...value, repository: kind === "bitbucket" ? { kind: "bitbucket", tokenEnvironment: "BITBUCKET_TOKEN" } : { kind: "github" } })}><SelectTrigger id="repository-host"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="github">GitHub</SelectItem><SelectItem value="bitbucket">Bitbucket Cloud</SelectItem></SelectContent></Select></Field>
    {repository.kind === "bitbucket" ? <><Field><FieldLabel htmlFor="bitbucket-token">Token environment variable</FieldLabel><Input id="bitbucket-token" value={repository.tokenEnvironment} onChange={event => onChange({ ...value, repository: { ...repository, tokenEnvironment: event.target.value } })} /></Field><Field><FieldLabel htmlFor="bitbucket-user">Email environment variable (optional)</FieldLabel><Input id="bitbucket-user" value={repository.usernameEnvironment ?? ""} onChange={event => onChange({ ...value, repository: { kind: "bitbucket", tokenEnvironment: repository.tokenEnvironment, ...(event.target.value ? { usernameEnvironment: event.target.value } : {}) } })} /></Field></> : null}
    <Field><FieldLabel htmlFor="issue-tracker">Issue tracker</FieldLabel><Select value={tracker?.kind ?? "none"} onValueChange={kind => onChange({ ...value, tracker: kind === "jira" ? { kind: "jira", site: "https://example.atlassian.net", project: "APP", emailEnvironment: "JIRA_EMAIL", tokenEnvironment: "JIRA_TOKEN" } : kind === "github" ? { kind: "github", repository: "" } : null })}><SelectTrigger id="issue-tracker"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">None</SelectItem><SelectItem value="github">GitHub Issues</SelectItem><SelectItem value="jira">Jira Cloud</SelectItem></SelectContent></Select></Field>
    {tracker?.kind === "github" ? <Field><FieldLabel htmlFor="issue-repository">Issue repository</FieldLabel><Input id="issue-repository" placeholder="owner/repository" value={tracker.repository} onChange={event => onChange({ ...value, tracker: { ...tracker, repository: event.target.value } })} /></Field> : null}
    {tracker?.kind === "jira" ? <>{([ ["site", "Jira site"], ["project", "Jira project key"], ["emailEnvironment", "Email environment variable"], ["tokenEnvironment", "Token environment variable"] ] as const).map(([key, label]) => <Field key={key}><FieldLabel htmlFor={`jira-${key}`}>{label}</FieldLabel><Input id={`jira-${key}`} value={tracker[key]} onChange={event => onChange({ ...value, tracker: { ...tracker, [key]: event.target.value } })} /></Field>)}</> : null}
  </FieldSet>;
}
