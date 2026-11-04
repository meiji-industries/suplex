import { describe, expect, it } from "vitest";

import type { MoveDraft } from "../contracts/generated/MoveDraft.js";
import type { MoveBody } from "../contracts/moves.js";
import { applyMoveDraft } from "../features/moves/lib/move-draft.js";

const current: MoveBody = { projectId: "project", name: "Old", prompt: "Old text", runner: "prompt", profileId: "profile", confirm: false, workflow: "standard", deliveryTarget: "pull_request_ready", runProjectTests: true, visualEvidence: "off" };
const proposed = (runner: MoveDraft["runner"]): MoveDraft => ({ name: "Deploy", runner, prompt: "make deploy", confirm: true, note: null });

describe("applyMoveDraft", () => {
  it("fills the editor fields and keeps the project", () => {
    expect(applyMoveDraft(current, proposed("prompt"), true)).toEqual({ ...current, name: "Deploy", prompt: "make deploy", confirm: true });
  });

  it("keeps the runner of an admin", () => {
    expect(applyMoveDraft(current, proposed("script"), true)).toMatchObject({ runner: "script", profileId: null, confirm: true });
    expect(applyMoveDraft(current, proposed("pull_request_tasks"), true)).toMatchObject({ runner: "pull_request_tasks", profileId: "profile", confirm: true });
  });

  it("changes a terminal runner to a task for a member", () => {
    for (const runner of ["prompt", "script"] as const) {
      expect(applyMoveDraft(current, proposed(runner), false)).toMatchObject({ name: "Deploy", prompt: "make deploy", runner: "task", profileId: null, confirm: false });
    }
  });

  it("keeps the runners that a member can use", () => {
    expect(applyMoveDraft(current, proposed("pull_request_tasks"), false).runner).toBe("pull_request_tasks");
    expect(applyMoveDraft(current, proposed("task"), false)).toMatchObject({ runner: "task", confirm: false });
  });

  it("resets task settings when a draft leaves the task runner", () => {
    const task: MoveBody = { ...current, runner: "task", workflow: "direct_build", deliveryTarget: "pull_request_draft", runProjectTests: false, visualEvidence: "capture" };
    expect(applyMoveDraft(task, proposed("pull_request_tasks"), true)).toMatchObject({ workflow: "standard", deliveryTarget: "pull_request_ready", runProjectTests: true, visualEvidence: "off" });
  });
});
