import { SquareTerminal } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { SettingsContent, SettingsLayout, SettingsSection } from "./settings-layout.js";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group.js";
import { toolIcons } from "../../components/app/tool-icons.js";
import { setExperiments } from "../../shell/experiments-api.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { withCompany } from "../../lib/api.js";
import { getEnvironmentSettings, updateEnvironmentSettings, type EnvironmentSettings } from "./lib/environment-api.js";

type TerminalChoice = "suplex" | "herdr";

const cardClass = "relative grid aspect-square w-44 cursor-pointer content-start gap-2 rounded-lg border bg-card p-4 text-sm hover:border-foreground/30 has-data-checked:border-foreground has-data-checked:bg-muted/50 has-focus-visible:ring-3 has-focus-visible:ring-ring/50 has-data-disabled:cursor-default has-data-disabled:opacity-60";

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
    <SettingsContent title="Terminal">
      <SettingsSection title="Terminal" description="Select the terminal for the Shell, Mirror, and sign-in panes. This setting applies to all users on this host.">
        <RadioGroup aria-label="Terminal" value={value} disabled={settings === null} onValueChange={(next) => void choose(next === "suplex" ? "suplex" : "herdr")} className="flex flex-wrap gap-4">
          <label className={cardClass}>
            <RadioGroupItem value="suplex" className="sr-only" />
            <SquareTerminal aria-hidden="true" className="size-10" strokeWidth={1.5} />
            <strong className="font-semibold">Suplex</strong>
            <p className="text-xs text-muted-foreground">Suplex runs the terminals. The Shell stops when the Suplex host restarts. Agent work continues.</p>
          </label>
          <label className={cardClass}>
            <RadioGroupItem value="herdr" className="sr-only" />
            <img aria-hidden="true" alt="" src={toolIcons["herdr-readiness"].src} className="size-10 rounded-md" />
            <strong className="font-semibold">Herdr</strong>
            <p className="text-xs text-muted-foreground">Herdr runs the terminals. The Shell continues when the Suplex host restarts.</p>
          </label>
        </RadioGroup>
      </SettingsSection>
      {message ? <p className="text-xs text-muted-foreground" role="status">{message}</p> : null}
    </SettingsContent>
  </SettingsLayout>;
}
