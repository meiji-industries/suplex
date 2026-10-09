import type { ReactElement } from "react";

import { withCompany } from "../../lib/api.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { navigate } from "../../shell/navigation-state.js";
import { ProviderLoginTerminal, useProviderLogin } from "../settings/provider-login.js";
import { OnboardingFrame, PrimaryButton } from "./onboarding-frame.js";
import { IntroSlide, INTRO_SLIDES } from "./onboarding-intro.js";
import { FirstTaskStep } from "./onboarding-first-task.js";
import { ProjectStep } from "./onboarding-project.js";
import { StackStep } from "./onboarding-stack.js";
import { TeamStep } from "./onboarding-team.js";
import { YouStep } from "./onboarding-you.js";
import { firstStep, INTRO_STEPS, ONBOARDING_STEPS, useOnboardingData, type IntroStepId, type OnboardingStepId } from "./onboarding.js";

export type StepProps = { onBack: () => void; onNext: () => void };

function requestedStep(): OnboardingStepId | undefined {
  const requested = new URLSearchParams(window.location.search).get("step");
  return ONBOARDING_STEPS.find(step => step === requested);
}

export function OnboardingView(): ReactElement {
  const { currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id ?? "";
  const data = useOnboardingData(currentCompany);
  const { login, loginPending, startLogin, closeLogin } = useProviderLogin({ reload: data.reload });
  // Without a company the first screen is unknown; show the empty window instead of a screen that jumps.
  if (!currentCompany) return <div className="onb" />;
  const step = requestedStep() ?? firstStep(data.state);
  const index = ONBOARDING_STEPS.indexOf(step);
  const go = (id: OnboardingStepId | undefined): void => { if (id) navigate(withCompany(`/onboarding?step=${id}`, companyId)); };
  const props: StepProps = { onBack: () => go(ONBOARDING_STEPS[index - 1]), onNext: () => go(ONBOARDING_STEPS[index + 1]) };
  const screen = INTRO_STEPS.includes(step as IntroStepId)
    ? <OnboardingFrame
      step={step}
      onBack={index > 0 ? props.onBack : undefined}
      skip={<a className="skip" href={withCompany("/onboarding?step=you", companyId)}>Skip intro →</a>}
      action={<PrimaryButton onClick={props.onNext}>{INTRO_SLIDES[step as IntroStepId].action}</PrimaryButton>}>
      <IntroSlide key={step} id={step as IntroStepId} />
    </OnboardingFrame>
    : step === "you" ? <YouStep {...props} data={data} />
    : step === "stack" ? <StackStep {...props} data={data} startLogin={startLogin} loginPending={loginPending} />
    : step === "team" ? <TeamStep {...props} data={data} />
    : step === "project" ? <ProjectStep {...props} data={data} />
    : <FirstTaskStep {...props} data={data} />;
  // Fades in once from the window ground, where the desktop launch screen faded out.
  return <div className="onb-enter">
    {screen}
    <ProviderLoginTerminal login={login} onClose={() => void closeLogin()} />
  </div>;
}
