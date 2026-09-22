import { useEffect, useMemo, useState, type ReactElement } from "react";

import { ApplicationFrame } from "../../shell/application-frame.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Checkbox } from "../../components/ui/checkbox.js";
import { Field, FieldGroup, FieldLabel } from "../../components/ui/field.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { readJson } from "../../lib/api.js";

interface Consent {
  requestId: string;
  clientName: string;
  redirectUri: string;
  redirectOrigin: string;
  scope: string;
  companies: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; name: string; companyId: string }>;
}

export function OAuthConsentView(): ReactElement {
  const requestId = useMemo(() => new URLSearchParams(window.location.search).get("request") ?? "", []);
  const [consent, setConsent] = useState<Consent>();
  const [companyId, setCompanyId] = useState("");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void readJson<Consent>(`/api/oauth/consent/${encodeURIComponent(requestId)}`).then((value) => {
      setConsent(value);
      const firstCompany = value.companies[0]?.id ?? "";
      setCompanyId(firstCompany);
      setProjectIds([]);
    }).catch(() => setError("Suplex could not read this authorization request."));
  }, [requestId]);

  const chooseCompany = (value: string | null): void => {
    const selected = value ?? "";
    setCompanyId(selected);
    setProjectIds([]);
  };
  const decide = async (decision: "approve" | "deny"): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const result = await readJson<{ redirectTo: string }>(`/api/oauth/consent/${encodeURIComponent(requestId)}/${decision}`, {
        method: "POST",
        body: decision === "approve" ? JSON.stringify({ companyId, projectIds }) : "{}",
      });
      window.location.assign(result.redirectTo);
    } catch {
      setError("Suplex could not save this decision.");
      setBusy(false);
    }
  };

  const visibleProjects = consent?.projects.filter((project) => project.companyId === companyId) ?? [];
  return (
    <ApplicationFrame title="Approve connection">
      <main className="mx-auto max-w-2xl space-y-4 px-4 py-4 sm:px-8">
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {consent ? (
          <section className="space-y-4 border bg-card p-4">
            <div className="space-y-1"><h1 className="text-sm font-semibold">Approve {consent.clientName}?</h1><p className="text-xs text-muted-foreground">The client name is not verified. Check the callback before you approve.</p></div>
            <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 text-xs"><dt className="text-muted-foreground">Callback</dt><dd className="break-all">{consent.redirectUri}</dd><dt className="text-muted-foreground">Destination</dt><dd>{consent.redirectOrigin}</dd><dt className="text-muted-foreground">Permission</dt><dd>Read and manage Suplex tasks through MCP</dd></dl>
            <FieldGroup>
              <Field><FieldLabel>Company</FieldLabel><Select value={companyId} onValueChange={chooseCompany}><SelectTrigger><SelectValue placeholder="Select a company" /></SelectTrigger><SelectContent>{consent.companies.map((company) => <SelectItem key={company.id} value={company.id}>{company.name}</SelectItem>)}</SelectContent></Select></Field>
              <Field><FieldLabel>Projects</FieldLabel><div className="space-y-2">{visibleProjects.map((project) => <label className="flex items-center gap-2 text-xs" key={project.id}><Checkbox checked={projectIds.includes(project.id)} onCheckedChange={(checked) => setProjectIds((current) => checked ? [...new Set([...current, project.id])] : current.filter((id) => id !== project.id))} />{project.name}</label>)}</div></Field>
            </FieldGroup>
            <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={() => void decide("deny")}>Reject</Button><Button disabled={busy || projectIds.length === 0} onClick={() => void decide("approve")}>Approve</Button></div>
          </section>
        ) : null}
      </main>
    </ApplicationFrame>
  );
}
