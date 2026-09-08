import type { TaskHarness } from "../../src/runtimes/task-harness.js";
import type { OpenCodeTaskScope } from "../../src/runtimes/opencode/task-runtime.js";
import type { OpenCodePromptIntent, OpenCodePromptObservation } from "../../src/runtimes/opencode/session.js";

export class FakeTaskHarness implements TaskHarness {
  readonly dispatched: OpenCodePromptIntent[] = [];
  readonly observations = new Map<string, OpenCodePromptObservation>();
  readonly sessions = new Map<string, string>();
  failAttachment = false;
  loseAcknowledgement = false;
  failStop = false;
  readonly stopped: string[] = [];
  readonly fenced: string[] = [];
  /** Per-message native answers; unmapped messages answer with a generic result. */
  readonly results = new Map<string, string>();
  readonly evidence = new Map<string, { tools: Array<{ id: string; name: string; status: "pending" | "running" | "completed" | "error"; input: Record<string, unknown>; output: string | null; error: string | null }>; limit: string | null }>();
  serverGeneration = "b775df17-718a-4cb2-8e23-6912b8aa0d39";

  async recoverDispatch(...[scope, intent, attempt]: Parameters<TaskHarness["recoverDispatch"]>): Promise<OpenCodePromptObservation> {
    if (this.failStop) throw new Error("Dispatch server stop could not be verified");
    this.fenced.push(attempt.serverGeneration);
    this.serverGeneration = "c775df17-718a-4cb2-8e23-6912b8aa0d39";
    return this.observe(scope, { ...intent, dispatch: "not_submitted" });
  }

  async stop(_scope: Pick<OpenCodeTaskScope, "id">, nativeSessionId: string | null): Promise<void> {
    if (this.failStop) throw new Error("Abort unavailable");
    if (nativeSessionId) this.stopped.push(nativeSessionId);
  }

  async ensureSession(scope: OpenCodeTaskScope, nativeSessionId: string | null): Promise<string> {
    const id = nativeSessionId ?? `ses_${scope.id.replaceAll("-", "")}`;
    this.sessions.set(scope.id, id);
    return id;
  }
  async attach(input: Parameters<TaskHarness["attach"]>[0]): Promise<string> {
    if (this.failAttachment) throw new Error("Herdr unavailable");
    const paneId = input.paneId ?? `pane-${input.scope.id}`;
    input.persistPane(paneId);
    return paneId;
  }
  async observe(_scope: OpenCodeTaskScope, intent: OpenCodePromptIntent): Promise<OpenCodePromptObservation> {
    return this.observations.get(intent.messageID) ?? { sessionID: intent.sessionID, messageID: intent.messageID, state: "unknown", admission: "not_observed", retry: intent.dispatch === "not_submitted" ? "allowed" : "forbidden", assistantMessageIDs: [] };
  }
  async dispatch(scope: OpenCodeTaskScope, intent: OpenCodePromptIntent, claim: Parameters<TaskHarness["dispatch"]>[2]): Promise<OpenCodePromptObservation> {
    if (!await claim(this.serverGeneration)) return this.observe(scope, { ...intent, dispatch: "ambiguous" });
    this.dispatched.push(intent);
    const observed: OpenCodePromptObservation = { sessionID: intent.sessionID, messageID: intent.messageID, state: "running", admission: "observed", retry: "forbidden", assistantMessageIDs: [] };
    this.observations.set(intent.messageID, observed);
    if (this.loseAcknowledgement) throw new Error("Lost prompt acknowledgement");
    return observed;
  }
  async resultText(_scope: OpenCodeTaskScope, observation: OpenCodePromptObservation): Promise<string> { return this.results.get(observation.messageID) ?? "Verified native result"; }
  async turnEvidence(_scope: OpenCodeTaskScope, observation: OpenCodePromptObservation) { return this.evidence.get(observation.messageID) ?? { tools: [], limit: null }; }
  finish(messageID: string, state: "completed" | "interrupted" | "error" = "completed", text?: string): void {
    const current = this.observations.get(messageID);
    if (!current) throw new Error("Prompt was not dispatched");
    if (text !== undefined) this.results.set(messageID, text);
    this.observations.set(messageID, { ...current, state, assistantMessageID: `assistant-${messageID}` });
  }
}
