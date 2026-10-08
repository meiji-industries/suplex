import type { ReactElement } from "react";

import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Progress } from "../../components/ui/progress.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { withCompany } from "../../lib/api.js";
import { ONBOARDING_STEPS, onboardingPath, onboardingSettingsPath, stepComplete, useOnboardingData } from "../onboarding/onboarding.js";
import { SettingsContent, SettingsLayout, SettingsSection, SettingRow } from "./settings-layout.js";

export function OnboardingSettingsView(): ReactElement {
  const { currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id ?? "";
  const { state } = useOnboardingData(currentCompany);
  const steps = ONBOARDING_STEPS.filter(step => step.id !== "done");
  const complete = steps.filter(step => stepComplete(state, step.id)).length;
  return <SettingsLayout title="Onboarding" companyId={companyId} backHref={withCompany("/", companyId)} activeHref={onboardingSettingsPath(companyId)}><SettingsContent title="Onboarding" actions={<Button size="sm" nativeButton={false} render={<a href={onboardingPath(companyId)} />}>Resume onboarding</Button>}><SettingsSection><SettingRow label={`${complete} of ${steps.length} steps complete`}><div className="w-40"><Progress aria-label="Onboarding progress" value={complete / steps.length * 100} /></div></SettingRow>{steps.map(step => <SettingRow key={step.id} label={step.label}>{stepComplete(state, step.id) ? <Badge variant="secondary">Complete</Badge> : <Badge variant="outline">Not complete</Badge>}</SettingRow>)}</SettingsSection></SettingsContent></SettingsLayout>;
}
