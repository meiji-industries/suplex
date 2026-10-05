import { AppWindow, Check, Copy, ExternalLink, Package, RefreshCw, RotateCw, SquareTerminal, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { SettingRow, SettingsContent, SettingsLayout } from "./settings-layout.js";
import { useSystemHealth } from "../../components/app/system-health.js";
import { Button } from "../../components/ui/button.js";
import { Spinner } from "../../components/ui/spinner.js";
import { Badge } from "../../components/ui/badge.js";
import { Field, FieldContent, FieldLabel, FieldTitle } from "../../components/ui/field.js";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group.js";
import { toolIcons } from "../../components/app/tool-icons.js";
import { setExperiments } from "../../shell/experiments-api.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { withCompany } from "../../lib/api.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { getEnvironmentSettings, updateEnvironmentSettings, type EnvironmentSettings } from "./lib/environment-api.js";

type TerminalChoice = "suplex" | "herdr";

const choices: { value: TerminalChoice; title: string; recommended?: boolean; points: [LucideIcon, string][]; icon: ReactElement }[] = [
  { value: "suplex", title: "Suplex", points: [[Package, "Built in, nothing to install"], [RotateCw, "Shells end when Suplex restarts"], [AppWindow, "Use it in Suplex"]], icon: <SquareTerminal aria-hidden="true" className="size-12 shrink-0" strokeWidth={1.25} /> },
  { value: "herdr", title: "Herdr", recommended: true, points: [[Package, "Needs Herdr running on the host"], [RotateCw, "Shells keep running when Suplex restarts"], [AppWindow, "Use it in Suplex, Terminal, or the Herdr app"]], icon: <img aria-hidden="true" alt="" src={toolIcons["herdr-readiness"].src} className="size-12 shrink-0 rounded-lg" /> },
];

function HerdrAvailability(): ReactElement {
  const { snapshot, refreshing, refresh, watch } = useSystemHealth();
  const [copied, setCopied] = useState(false);
  useEffect(() => watch(), [watch]);
  const check = snapshot?.checks.find(candidate => candidate.id === "herdr-readiness");
  const version = check?.details.serverVersion ?? check?.details.clientVersion;
  const copy = async (command: string): Promise<void> => {
    setCopied(await copyToClipboard(command, "Copied the Herdr command to clipboard"));
  };
  const status = !check ? null : check.status === "healthy" ? <Badge variant="green">Available</Badge> : check.summary.endsWith("is not installed") ? <Badge variant="destructive">Not installed</Badge> : check.status === "warning" ? <Badge variant="amber">Needs attention</Badge> : <Badge variant="destructive">Unavailable</Badge>;
  return <section className="mb-10">
    <div className="mb-3 flex items-start justify-between gap-3 px-4">
      <div className="space-y-1"><h3 className="text-base font-medium">Herdr</h3><p className="text-xs text-muted-foreground">The Herdr option needs Herdr running on the Suplex host.</p></div>
      <Button size="icon-sm" variant="ghost" aria-label="Check Herdr again" title="Check again" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? <Spinner /> : <RefreshCw />}</Button>
    </div>
    <div className="overflow-hidden rounded-lg border bg-card px-5 py-2 [&>:last-child:not([data-setting-row])]:pb-3">
    <SettingRow label="Availability" description={check ? `${check.summary}${check.status === "healthy" && typeof version === "string" ? ` · ${version}` : ""}` : "Suplex is checking the host."}>
      {status ?? <Spinner />}
    </SettingRow>
    {check?.remedy ? <div className="space-y-2 border-t py-3">
      <p className="text-sm font-medium">{check.summary.endsWith("is not installed") ? "Install Herdr" : "Fix Herdr"}</p>
      {check.remedyKind === "link" ? <Button size="sm" variant="outline" nativeButton={false} render={<a href={check.remedy} target="_blank" rel="noreferrer" />}><ExternalLink />Open the instructions</Button> : <>
        <p className="text-xs text-muted-foreground">Run this in a terminal on the Suplex host, then check again.</p>
        <div className="flex items-center gap-2 rounded-md border bg-muted/30 py-1.5 pr-1.5 pl-3">
          <code className="min-w-0 flex-1 break-all text-xs">{check.remedy}</code>
          <Button size="xs" variant="outline" onClick={() => void copy(check.remedy ?? "")}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy"}</Button>
        </div>
      </>}
    </div> : null}
    </div>
  </section>;
}

export function TerminalSettingsView(): ReactElement {
  const { currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id ?? "";
  const [settings, setSettings] = useState<EnvironmentSettings | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    void getEnvironmentSettings()
      .then(setSettings)
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Terminal settings could not be loaded"));
  }, []);

  const choose = async (choice: TerminalChoice): Promise<void> => {
    const previous = settings;
    if (!previous) return;
    setSettings({ ...previous, hostTerminalEnabled: choice === "suplex" });
    setMessage("");
    try {
      const saved = await updateEnvironmentSettings({ hostTerminalEnabled: choice === "suplex" });
      setSettings(saved);
      setExperiments({ todayPage: saved.todayPageEnabled, hostTerminal: saved.hostTerminalEnabled });
    } catch (error) {
      setSettings(previous);
      setMessage(error instanceof Error ? error.message : "Terminal settings could not be saved");
    }
  };

  // Herdr is the default until the host answers, so one card is always selected.
  const value: TerminalChoice = settings?.hostTerminalEnabled ? "suplex" : "herdr";
  return <SettingsLayout title="Terminal" companyId={companyId} backHref={withCompany("/", companyId)} activeHref={withCompany("/admin/terminal", companyId)}>
    <SettingsContent title="Terminal" description="Choose what runs the Shell, Mirror, and sign-in panes. This applies to every user on this host.">
      <RadioGroup aria-label="Terminal" value={value} disabled={settings === null} onValueChange={(next) => void choose(next === "suplex" ? "suplex" : "herdr")} className="mb-10 grid gap-3 sm:grid-cols-2">
        {choices.map(choice => <FieldLabel key={choice.value} htmlFor={`terminal-${choice.value}`} className="cursor-pointer bg-card hover:bg-muted/40">
          <Field className="gap-3 p-4!">
            <div className="flex items-start justify-between">{choice.icon}<RadioGroupItem id={`terminal-${choice.value}`} value={choice.value} aria-label={choice.title} /></div>
            <FieldContent><FieldTitle>{choice.title}{choice.recommended ? <Badge variant="outline">Recommended</Badge> : null}</FieldTitle><ul className="grid gap-1.5 pt-1 text-xs text-muted-foreground">{choice.points.map(([Icon, text]) => <li key={text} className="flex items-center gap-2"><Icon aria-hidden="true" className="size-3.5 shrink-0" />{text}</li>)}</ul></FieldContent>
          </Field>
        </FieldLabel>)}
      </RadioGroup>
      <HerdrAvailability />
      {message ? <p className="mt-3 px-4 text-xs text-muted-foreground" role="status">{message}</p> : null}
    </SettingsContent>
  </SettingsLayout>;
}
