import { useEffect, useRef, useState, type ReactElement } from "react";

import { withCompany } from "../../lib/api.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { navigate } from "../../shell/navigation-state.js";
import { supportsDeliveryTarget } from "../tasks/lib/delivery-target-capabilities.js";
import { createTask } from "../tasks/lib/task-api.js";
import { useTaskCache } from "../tasks/task-data.js";
import { Fit, OnboardingFrame } from "./onboarding-frame.js";
import type { OnboardingData } from "./onboarding.js";
import type { StepProps } from "./onboarding-wizard.js";

const icon = (path: ReactElement): ReactElement => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{path}</svg>;

/** Open starters that work on any repository. Picking one fills the title and the description. */
const STARTERS = [
  { label: "Map this codebase", icon: icon(<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14" />), title: "Map this codebase", description: "Read the repository and write docs/ARCHITECTURE.md: the main modules, how a request moves through them, and where to make common changes." },
  { label: "Add a test", icon: icon(<path d="m5 12 5 5 9-10" />), title: "Add 1 test where coverage is thinnest", description: "Find the least-tested parts of the repo, write one test for the most important path, and make sure the full suite passes." },
  { label: "Find and fix a bug", icon: icon(<><rect x="7" y="7" width="10" height="13" rx="5" /><path d="M12 11v9M3 13h4M17 13h4M5 7l3 2M19 7l-3 2M9 4l1.5 2.5M15 4l-1.5 2.5" /></>), title: "Find and fix a bug", description: "Find a real bug in the code or the open issues, fix it, and add a test that fails without the fix." },
  { label: "Update dependencies", icon: icon(<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12 4 7.5" />), title: "Update outdated dependencies", description: "Update the dependencies that are behind to their latest compatible versions, fix any breaking changes, and make sure the full suite passes." },
  { label: "Improve the README", icon: icon(<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5" />), title: "Improve the README", description: "Make the README explain what the project does, how to install and run it, and how to run the tests. Check that every command works." },
] as const;

const FACE = <svg width="20" height="20" viewBox="0 0 14 14" aria-hidden="true"><path d="M3.5 5.5h1.5M9 5.5h1.5M4.5 9.5h5" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" /></svg>;

export function FirstTaskStep({ onBack, data }: StepProps & { data: OnboardingData }): ReactElement {
  const { currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id ?? "";
  const cacheTask = useTaskCache();
  const project = data.state.projects[0];
  const root = data.state.profiles.find(profile => profile.id === project?.rootProfileId);
  const worker = data.state.profiles.find(profile => profile.id === project?.workerProfileId);
  const ready = supportsDeliveryTarget(project?.integration?.repository, "pull_request_ready");
  const [starter, setStarter] = useState<number>();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const typing = useRef<number | undefined>(undefined);
  const idempotencyKey = useRef(crypto.randomUUID());

  // Picking a starter types its title, then shows its description.
  const pick = (index: number): void => {
    const chosen = STARTERS[index]!;
    window.clearInterval(typing.current);
    setStarter(index);
    setDescription("");
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { setTitle(chosen.title); setDescription(chosen.description); return; }
    let length = 0;
    typing.current = window.setInterval(() => {
      length += 2;
      setTitle(chosen.title.slice(0, length));
      if (length >= chosen.title.length) { window.clearInterval(typing.current); setDescription(chosen.description); }
    }, 28);
  };
  useEffect(() => { const timer = window.setTimeout(() => pick(1), 500); return () => { window.clearTimeout(timer); window.clearInterval(typing.current); }; }, []);

  const finish = (path: string): void => navigate(withCompany(path, companyId));
  const create = async (): Promise<void> => {
    if (busy || !project || !title.trim()) return;
    setBusy(true);
    setError("");
    try {
      const task = await createTask(companyId, { projectId: project.id, title: title.trim(), description: description.trim(), startImmediately: true, deliveryTarget: ready ? "pull_request_ready" : "pull_request_draft", runProjectTests: true, workflow: "standard", idempotencyKey: idempotencyKey.current });
      cacheTask(task);
      finish(`/tasks/${task.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Suplex could not create the task.");
      setBusy(false);
    }
  };

  return <OnboardingFrame step="first-task" onBack={onBack} action={<button className="back" type="button" style={{ fontSize: 15 }} onClick={() => finish("/today")}>Skip for now →</button>}>
    <Fit gap={64}>
      <div className="copy" style={{ gap: 8 }}>
        <h1 className="h1">Give your team its first job.</h1>
        <p className="sub">Pick a starter for {project?.repository ?? project?.name ?? "your project"}, or write your own.</p>
      </div>
      <form style={{ width: 1000, display: "flex", flexDirection: "column", gap: 64 }} onSubmit={event => { event.preventDefault(); void create(); }} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.requestSubmit(); } }}>
        <div className="row" role="group" aria-label="Starters" style={{ justifyContent: "center", gap: 10, flexWrap: "wrap" }}>
          {STARTERS.map((each, index) => <button key={each.label} className="sgc" type="button" aria-pressed={starter === index} disabled={busy} onClick={() => pick(index)}>{starter === index ? icon(<path d="m5 12 5 5 9-10" />) : each.icon}{each.label}</button>)}
        </div>
        <div className="ftask">
          <div style={{ padding: "22px 24px 20px", display: "flex", flexDirection: "column" }}>
            <div className="row" style={{ gap: 12, fontSize: 14 }}>
              <span className="row" style={{ gap: 6, color: "#cfcfcf" }}>
                <span style={{ width: 17, height: 17, borderRadius: 4, background: "#0ea5b7", display: "grid", placeItems: "center" }}><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 18 18 6M10 6h8v8" /></svg></span>
                {project?.repository ?? project?.name}
              </span>
              <span className="dimmer">›</span>
              <span style={{ color: "#a3a3a3", fontSize: 15 }}>New task</span>
            </div>
            <input className="ftitle" aria-label="Task title" placeholder="Task title" required disabled={busy} value={title} onChange={event => { window.clearInterval(typing.current); setTitle(event.target.value); }} />
            <textarea key={starter} className="fdesc onb-fade-in" aria-label="Task description" placeholder="Write a description" rows={2} disabled={busy} value={description} onChange={event => setDescription(event.target.value)} />
            {error ? <p className="error" role="alert" style={{ marginTop: 10 }}>{error}</p> : null}
            <div className="row" style={{ marginTop: 22, gap: 10 }}>
              <div className="seq" aria-label="Task options">
                <span>{icon(<path d="M7 4v16l13-8z" />)}Run</span>
                <span style={{ background: "#12160a", boxShadow: "inset 0 0 0 1px #4a5a1f" }}>{icon(<path d="M4 7h3M4 12h3M4 17h3M10 7h10M10 12h10M10 17h10" />)}Plan and build</span>
                <span className="w">with</span>
                <span>{icon(<path d="M4 20h4L19 9l-4-4L4 16z" />)}tests</span>
                <span className="w">then</span>
                <span>{icon(<><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="19" r="2" /><path d="M6 7v10M18 17V9a3 3 0 0 0-3-3h-3" /></>)}open a {ready ? "PR" : "draft PR"}</span>
              </div>
              <span style={{ flex: 1 }} />
              <button className="btn" type="submit" style={{ height: 40, padding: "0 7px 0 18px", fontSize: 15 }} disabled={busy || !project || !title.trim()}>
                <span style={{ fontSize: 18, lineHeight: 1 }} aria-hidden="true">+</span>{busy ? "Creating…" : "Create task"}
                <span className="key" aria-hidden="true" style={{ width: "auto", padding: "0 7px", gap: 2, fontFamily: "var(--mono)", fontSize: 12 }}>⌘<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M19 5v7a3 3 0 0 1-3 3H6" /><path d="m10 11-4 4 4 4" /></svg></span>
              </button>
            </div>
          </div>
          <div className="fflow" aria-label="Workflow preview">
            <div key={starter} style={{ position: "relative", width: 760, height: 104, margin: "0 auto" }}>
              <svg className="abs" style={{ left: 0, top: 0 }} width="760" height="104" viewBox="0 0 760 104" aria-hidden="true">
                <path data-anim="wire-1" d="M108 34 H262" stroke="#8b5cf6" strokeWidth="1.5" fill="none" /><path d="M262 29.5 l8 4.5 -8 4.5z" fill="#8b5cf6" />
                <path data-anim="wire-2" d="M298 34 H452" stroke="#2dd4bf" strokeWidth="1.5" fill="none" /><path d="M452 29.5 l8 4.5 -8 4.5z" fill="#2dd4bf" />
                <path data-anim="wire-3" d="M488 34 H642" stroke="#8b5cf6" strokeWidth="1.5" fill="none" /><path d="M642 29.5 l8 4.5 -8 4.5z" fill="#8b5cf6" />
                <path data-anim="loop" d="M475 14 V4 H285 V12" stroke="#8b5cf6" strokeWidth="1.4" fill="none" strokeDasharray="4 3" /><circle cx="285" cy="13" r="2.5" fill="#8b5cf6" />
              </svg>
              <div className="nd abs" style={{ left: 5, top: 16 }}><span className="face" style={{ background: "#6b6bf0" }}>{FACE}</span><b>{root?.name ?? "Coordinator"}</b><span>writes the plan</span></div>
              <div className="nd abs" style={{ left: 195, top: 16 }}><span className="face" style={{ background: "#3b82f6", boxShadow: "0 0 0 6px #3b82f622" }}>{FACE}</span><b>{worker?.name ?? "Worker"}</b><span>does the work</span></div>
              <div className="nd abs" style={{ left: 385, top: 16 }}><span className="face" style={{ background: "#6b6bf0" }}>{FACE}</span><b>{root?.name ?? "Coordinator"}</b><span>reviews and checks</span></div>
              <div className="nd abs" style={{ left: 575, top: 16 }}><span className="face"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#ededed" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 5H8.5a3.5 3.5 0 0 0 0 7h7a3.5 3.5 0 0 1 0 7H6" /></svg></span><b>Suplex</b><span>opens a {ready ? "ready" : "draft"} PR</span></div>
            </div>
          </div>
        </div>
      </form>
    </Fit>
  </OnboardingFrame>;
}
