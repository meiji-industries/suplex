import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatAgentTurn } from "../src/frontend/components/app/task-chat/chat-agent-turn.js";
import { ChatComposer } from "../src/frontend/components/app/task-chat/chat-composer.js";
import { ChatMemberMessage } from "../src/frontend/components/app/task-chat/chat-member-message.js";

const completed = { kind: "agent_turn" as const, id: "turn", role: "builder" as const, agent: { name: "Builder", avatarSeed: "builder" }, startedAt: "2026-08-23T00:00:00.000Z", finishedAt: "2026-08-23T00:00:40.000Z", status: "completed" as const, events: [{ id: "file", at: "2026-08-23T00:00:10.000Z", kind: "file_change", text: "Updated task-chat.ts", files: ["src/task-chat.ts"] }], stats: { filesChanged: 1, additions: 12, deletions: 3 } };

describe("task chat UI", () => {
  it("renders collapsed completed work with change stats", () => {
    const html = renderToStaticMarkup(createElement(ChatAgentTurn, { item: completed, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    expect(html).toContain("Worked for 40s");
    expect(html).toContain("+12 −3");
  });

  it("renders a running header, composer reason, and markdown member body", () => {
    const running = { ...completed, finishedAt: null, status: "running" as const };
    const runningHtml = renderToStaticMarkup(createElement(ChatAgentTurn, { item: running, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    expect(runningHtml).toContain("Working for");
    expect(runningHtml).toContain("src/task-chat.ts");
    expect(renderToStaticMarkup(createElement(ChatComposer, { disabled: true, disabledReason: "Planner feedback is unavailable.", onSubmit: async () => undefined }))).toContain("Planner feedback is unavailable.");
    expect(renderToStaticMarkup(createElement(ChatMemberMessage, { item: { kind: "member", id: "message", at: "2026-08-23T00:00:00.000Z", actor: { name: "Mara", avatarSeed: "mara" }, markdown: "**Hello**" } }))).toContain("<strong>Hello</strong>");
  });

  it("shows collapsed command results and repeated event counts", () => {
    const item = { ...completed, finishedAt: null, status: "running" as const, events: [{ id: "command", at: "2026-08-23T00:00:10.000Z", kind: "command", text: "Inspecting Git state", output: "one\ntwo\nthree\nfour", exitCode: 0, status: "completed" as const }, { id: "repeat", at: "2026-08-23T00:00:11.000Z", kind: "agent_update", text: "Checking files", count: 4 }] };
    const html = renderToStaticMarkup(createElement(ChatAgentTurn, { item, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    expect(html).toContain("Inspecting Git state");
    expect(html).toContain("exit 0");
    expect(html).toContain("… +1 lines");
    expect(html).toContain("×4");
  });

  it("renders typed reasoning, command, and tool-call events", () => {
    const item = { ...completed, finishedAt: null, status: "running" as const, events: [
      { id: "reasoning", at: "2026-08-23T00:00:10.000Z", kind: "thinking_summary", text: "one\ntwo\nthree\nfour\nfive" },
      { id: "failed", at: "2026-08-23T00:00:11.000Z", kind: "command", text: "pnpm test", exitCode: 1, status: "completed" as const },
      { id: "tool", at: "2026-08-23T00:00:12.000Z", kind: "tool_call", text: "exec", detail: "call-123", count: 3 },
      { id: "message", at: "2026-08-23T00:00:13.000Z", kind: "message", text: "**Done**" },
    ] };
    const html = renderToStaticMarkup(createElement(ChatAgentTurn, { item, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    expect(html).toContain("data-task-chat-reasoning");
    expect(html).toContain("Show more");
    expect(html).toContain("exit 1");
    expect(html).toContain("data-variant=\"destructive\"");
    expect(html).toContain("exec");
    expect(html).toContain("call-123");
    expect(html).toContain("×3");
    expect(html).toContain("<strong>Done</strong>");
  });
});
