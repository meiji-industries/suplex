import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatAgentTurn } from "../src/frontend/components/app/task-chat/chat-agent-turn.js";
import { ChatComposer } from "../src/frontend/components/app/task-chat/chat-composer.js";
import { ChatMemberMessage } from "../src/frontend/components/app/task-chat/chat-member-message.js";

const completed = { kind: "agent_turn" as const, id: "turn", role: "builder" as const, agent: { name: "Builder", avatarSeed: "builder" }, startedAt: "2026-08-23T00:00:00.000Z", finishedAt: "2026-08-23T00:00:40.000Z", status: "completed" as const, intro: "I will inspect the exact delivered commit.", events: [{ id: "command", at: "2026-08-23T00:00:10.000Z", kind: "command", text: "git status", exitCode: 0, status: "completed" as const }, { id: "message", at: "2026-08-23T00:00:11.000Z", kind: "message", text: "I found three in-scope blocking gaps." }, { id: "tool", at: "2026-08-23T00:00:12.000Z", kind: "tool_call", text: "read" }, { id: "update", at: "2026-08-23T00:00:13.000Z", kind: "agent_update", text: "The service now gathers all campaign routes." }, { id: "reasoning", at: "2026-08-23T00:00:14.000Z", kind: "thinking_summary", text: "Reasoning details" }, { id: "file", at: "2026-08-23T00:00:15.000Z", kind: "file_change", text: "Updated task-chat.ts", files: ["src/task-chat.ts"] }], summary: "The work is complete.", stats: { filesChanged: 1, additions: 12, deletions: 3 } };

describe("task chat UI", () => {
  it("renders collapsed completed work with narration and change stats", () => {
    const html = renderToStaticMarkup(createElement(ChatAgentTurn, { item: completed, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    expect(html).toContain("Worked for 40s");
    expect(html).toContain("+12 −3");
    expect(html).toContain("4 steps");
    expect(html).toContain("data-task-chat-execution-chain");
    expect(html).toMatch(/aria-expanded="false"/);
    expect(html).toContain("I will inspect the exact delivered commit.");
    expect(html).toContain("I found three in-scope blocking gaps.");
    expect(html).toContain("The service now gathers all campaign routes.");
    expect(html).toContain("The work is complete.");
    expect(html).not.toContain("git status");
    expect(html).not.toContain("Reasoning details");
    expect(html).not.toContain("Updated task-chat.ts");
    expect(html).not.toContain("data-task-chat-execution-group");
  });

  it("renders a compact execution chain apart from narration bubbles", () => {
    const item = { ...completed, finishedAt: null, status: "running" as const, events: [
      { id: "command-one", at: "2026-08-23T00:00:10.000Z", kind: "command", text: "git status", exitCode: 0, status: "completed" as const },
      { id: "message", at: "2026-08-23T00:00:11.000Z", kind: "message", text: "I found three in-scope blocking gaps." },
      { id: "tool", at: "2026-08-23T00:00:12.000Z", kind: "tool_call", text: "read" },
      { id: "update", at: "2026-08-23T00:00:13.000Z", kind: "agent_update", text: "The service now gathers all campaign routes." },
      { id: "command-two", at: "2026-08-23T00:00:14.000Z", kind: "command", text: "pnpm test", exitCode: 0, status: "completed" as const },
    ] };
    const html = renderToStaticMarkup(createElement(ChatAgentTurn, { item, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    expect(html.match(/data-task-chat-agent-bubble/g)).toHaveLength(4);
    expect(html.match(/data-task-chat-execution-group/g)).toHaveLength(1);
    expect(html).toContain("3 steps");
    expect(html).toMatch(/data-task-chat-execution-chain[^>]*>.*data-task-chat-execution-group[^>]*>.*git status.*read.*pnpm test/s);
    expect(html).not.toContain("border-l");
    expect(html.match(/<ol data-task-chat-execution-group[^]*?<\/ol>/)?.[0]).not.toContain("data-task-chat-agent-bubble");
  });

  it("renders a running header, execution groups, composer reason, and markdown member body", () => {
    const running = { ...completed, finishedAt: null, status: "running" as const };
    const runningHtml = renderToStaticMarkup(createElement(ChatAgentTurn, { item: running, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    expect(runningHtml).toContain("Working for");
    expect(runningHtml).toMatch(/aria-expanded="true"/);
    expect(runningHtml).toContain("git status");
    expect(runningHtml).toContain("read");
    expect(runningHtml).toContain("src/task-chat.ts");
    expect(renderToStaticMarkup(createElement(ChatComposer, { disabled: true, disabledReason: "Planner feedback is unavailable.", onSubmit: async () => undefined }))).toContain("Planner feedback is unavailable.");
    expect(runningHtml).toContain("motion-safe:animate-spin");
    expect(renderToStaticMarkup(createElement(ChatMemberMessage, { item: { kind: "member", id: "message", at: "2026-08-23T00:00:00.000Z", actor: { name: "Mara", avatarSeed: "mara" }, markdown: "**Hello**" } }))).toContain("<strong>Hello</strong>");
  });

  it("keeps completed command output hidden in an independently collapsed row", () => {
    const item = { ...completed, finishedAt: null, status: "running" as const, events: [{ id: "command", at: "2026-08-23T00:00:10.000Z", kind: "command", text: "Inspecting Git state", output: "one\ntwo\nthree\nfour", exitCode: 0, status: "completed" as const }, { id: "repeat", at: "2026-08-23T00:00:11.000Z", kind: "agent_update", text: "Checking files", count: 4 }] };
    const html = renderToStaticMarkup(createElement(ChatAgentTurn, { item, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    expect(html).toContain("Inspecting Git state");
    expect(html).toContain("data-task-chat-command");
    expect(html).not.toContain("one\ntwo\nthree\nfour");
    expect(html).toMatch(/aria-expanded="true"[^]*aria-expanded="false"/);
    expect(html).toContain("×4");
  });

  it("opens running command rows with their full terminal output", () => {
    const item = { ...completed, finishedAt: null, status: "running" as const, events: [{ id: "command", at: "2026-08-23T00:00:10.000Z", kind: "command", text: "pnpm test", output: "one\ntwo\nthree\nfour", exitCode: null, status: "running" as const }] };
    const html = renderToStaticMarkup(createElement(ChatAgentTurn, { item, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    expect(html).toContain("$ pnpm test\none\ntwo\nthree\nfour");
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(2);
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
    expect(html).toContain("Thinking");
    expect(html).toMatch(/one<br\/>\s*two<br\/>\s*three<br\/>\s*four<br\/>\s*five/);
    expect(html).not.toContain("Reasoning");
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1);
    expect(html).toContain("exit 1");
    expect(html).toContain("data-variant=\"destructive\"");
    expect(html).toContain("exec");
    expect(html).toContain("×3");
    expect(html).toContain("call-123");
    expect(html.match(/<li data-task-chat-tool-call[^]*?<\/li>/)?.[0]).not.toContain("aria-expanded");
    expect(html).toContain("<strong>Done</strong>");
  });
});
