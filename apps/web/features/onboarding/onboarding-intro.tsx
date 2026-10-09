import type { ReactElement } from "react";

import { Fit } from "./onboarding-frame.js";
import type { IntroStepId } from "./onboarding.js";
import promise from "./motion/m11.html?raw";
import input from "./motion/m12.html?raw";
import workflows from "./motion/m13.html?raw";
import parallel from "./motion/m14.html?raw";
import automate from "./motion/m15.html?raw";
import analytics from "./motion/m16.html?raw";
import companies from "./motion/m17.html?raw";

type Slide = { scope: string; stage: { __html: string }; title: string; accent: string; sub: string; subWidth?: number; action: string };

// Stages are the motion file's markup as shipped: its CSS keys on their inline styles, so they stay HTML.
// Each `{ __html }` object is created once: React rewrites the HTML, and restarts its animations, when the object changes.
export const INTRO_SLIDES: Record<IntroStepId, Slide> = {
  promise: { scope: "m11", stage: { __html: promise }, title: "Your agents do the work.", accent: "Suplex runs the workflow.", sub: "Plan. Build. Review. Ship. You stay in control at every step.", action: "See how it works" },
  input: { scope: "m12", stage: { __html: input }, title: "Text it. Say it. Show it.", accent: "Suplex turns it into work.", sub: "Type a task, talk it through, paste a screenshot, or send it from another agent.", subWidth: 418, action: "Next" },
  workflows: { scope: "m13", stage: { __html: workflows }, title: "Workflows, not prompts.", accent: "Every task runs a proven play.", sub: "The Coordinator plans. The Worker builds. The Coordinator reviews. Nothing ships until it passes.", subWidth: 598, action: "Next" },
  parallel: { scope: "m14", stage: { __html: parallel }, title: "Parallel by default.", accent: "Watch every agent work.", sub: "Every task gets its own branch, so agents never collide. Track them on the Board, or watch every agent live on the Timeline.", subWidth: 620, action: "Next" },
  automate: { scope: "m15", stage: { __html: automate }, title: "One click or one label.", accent: "Work starts itself.", sub: "Save a Move once and run it across every task or pull request. Or let a GitHub label, Linear issue or Slack message kick off the work.", subWidth: 640, action: "Next" },
  analytics: { scope: "m16", stage: { __html: analytics }, title: "No black boxes.", accent: "Every task, accounted for.", sub: "See estimated spend, delivery rate and agent time by project and by model. You pay your providers directly. We never mark up tokens.", action: "Next" },
  companies: { scope: "m17", stage: { __html: companies }, title: "Every client, its own lane.", accent: "Run the whole operation.", sub: "Give each client their own projects, agents and credentials. Switch between them in one click.", subWidth: 533, action: "Set up Suplex" },
};

/** One intro slide: its animated stage over the headline. Remounting the slide replays the stage. */
export function IntroSlide({ id }: { id: IntroStepId }): ReactElement {
  const slide = INTRO_SLIDES[id];
  return <Fit>
    <div className={slide.scope} aria-hidden="true" dangerouslySetInnerHTML={slide.stage} />
    <div className="copy">
      <h1 className="h1">{slide.title}<br /><em>{slide.accent}</em></h1>
      <p className="sub" style={slide.subWidth ? { width: slide.subWidth } : undefined}>{slide.sub}</p>
    </div>
  </Fit>;
}
