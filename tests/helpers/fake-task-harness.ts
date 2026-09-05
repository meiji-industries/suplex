import type { TaskHarness } from "../../src/root-controller.js";
import type { OpenCodeTaskScope } from "../../src/opencode-task-runtime.js";
import type { OpenCodePromptClaim, OpenCodePromptIntent, OpenCodePromptObservation } from "../../src/opencode-session.js";

export class FakeTaskHarness implements TaskHarness {
  readonly dispatched: OpenCodePromptIntent[] = [];
  readonly observations = new Map<string, OpenCodePromptObservation>();
  readonly sessions = new Map<string, string>();
  failAttachment = false;
  loseAcknowledgement = false;
  failStop = false;
  readonly stopped: string[] = [];

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
  async dispatch(scope: OpenCodeTaskScope, intent: OpenCodePromptIntent, claim: OpenCodePromptClaim): Promise<OpenCodePromptObservation> {
    if (!await claim(intent)) return this.observe(scope, { ...intent, dispatch: "ambiguous" });
    this.dispatched.push(intent);
    const observed: OpenCodePromptObservation = { sessionID: intent.sessionID, messageID: intent.messageID, state: "running", admission: "observed", retry: "forbidden", assistantMessageIDs: [] };
    this.observations.set(intent.messageID, observed);
    if (this.loseAcknowledgement) throw new Error("Lost prompt acknowledgement");
    return observed;
  }
  async resultText(): Promise<string> { return "Verified native result"; }
  finish(messageID: string, state: "completed" | "interrupted" | "error" = "completed"): void {
    const current = this.observations.get(messageID);
    if (!current) throw new Error("Prompt was not dispatched");
    this.observations.set(messageID, { ...current, state, assistantMessageID: `assistant-${messageID}` });
  }
}
