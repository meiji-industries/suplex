import { useEffect, useLayoutEffect, useRef, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from "react";

import { INTRO_STEPS, ONBOARDING_STEPS, SETUP_STEPS, type OnboardingStepId } from "./onboarding.js";
import "./onboarding.css";

/** The onboarding window: Back and Skip at the top, the screen, then progress and the main action. */
export function OnboardingFrame({ step, onBack, skip, action, bodyClassName, children }: {
  step: OnboardingStepId;
  onBack?: (() => void) | undefined;
  skip?: ReactNode;
  action: ReactNode;
  bodyClassName?: string | undefined;
  children: ReactNode;
}): ReactElement {
  useEffect(() => { document.title = "Suplex · Onboarding"; }, []);
  return <div className="onb">
    <div className="bar" data-tauri-drag-region="deep">
      {onBack ? <button className="nav-back" type="button" onClick={onBack}>← Back</button> : null}
      {skip}
    </div>
    <main className={bodyClassName ? `body ${bodyClassName}` : "body"}>{children}</main>
    <div className="foot">
      <OnboardingProgress step={step} />
      <div className="row">{action}</div>
    </div>
  </div>;
}

function OnboardingProgress({ step }: { step: OnboardingStepId }): ReactElement {
  const index = ONBOARDING_STEPS.indexOf(step);
  const intro = Math.min(index + 1, INTRO_STEPS.length);
  const setup = Math.max(0, Math.min(index + 1 - INTRO_STEPS.length, SETUP_STEPS.length));
  const first = step === "first-task" ? 1 : 0;
  const act = first ? 2 : setup ? 1 : 0;
  const groups = [["How it works", INTRO_STEPS.length, intro], ["Set up", SETUP_STEPS.length, setup], ["First task", 1, first]] as const;
  return <div className="segs">
    <span className="sr-only">{`Step ${index + 1} of ${ONBOARDING_STEPS.length}`}</span>
    {groups.map(([label, total, filled], group) => <div key={label} className={group === act ? "seg on" : "seg"} aria-hidden="true">
      <b>{Array.from({ length: total }, (_, item) => <i key={item} className={item < filled ? "f" : undefined} />)}</b>
      <span>{label}</span>
    </div>)}
  </div>;
}

/** The lime pill with the Enter hint. Enter on the page, outside a field, presses it. */
export function PrimaryButton({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>): ReactElement {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const press = (event: KeyboardEvent): void => {
      if (event.key !== "Enter" || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (document.activeElement && document.activeElement !== document.body) return;
      event.preventDefault();
      button.current?.click();
    };
    window.addEventListener("keydown", press);
    return () => window.removeEventListener("keydown", press);
  }, []);
  return <button ref={button} className="btn" type="button" {...props}>
    {children}
    <span className="key" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M19 5v7a3 3 0 0 1-3 3H6" /><path d="m10 11-4 4 4 4" /></svg></span>
  </button>;
}

/** Scales a fixed-size design down, never up, so it fits the space it gets. */
export function Fit({ gap, children }: { gap?: number; children: ReactNode }): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const fit = (): void => {
      const outer = box.current;
      const content = inner.current;
      if (!outer || !content) return;
      content.style.transform = "none";
      content.style.margin = "0";
      const width = content.offsetWidth;
      const height = content.offsetHeight;
      const scale = Math.min(1, outer.clientWidth / width, outer.clientHeight / height);
      content.style.transform = `scale(${scale})`;
      content.style.marginRight = `${width * scale - width}px`;
      content.style.marginBottom = `${height * scale - height}px`;
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(box.current!);
    return () => observer.disconnect();
  }, []);
  return <div ref={box} className="fit-box"><div ref={inner} className="fit" style={gap === undefined ? undefined : { gap }}>{children}</div></div>;
}
