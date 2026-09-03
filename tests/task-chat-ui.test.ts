import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatAgentTurn } from "../src/frontend/components/app/task-chat/chat-agent-turn.js";
import { ChatComposer } from "../src/frontend/components/app/task-chat/chat-composer.js";
import { ChatMemberMessage } from "../src/frontend/components/app/task-chat/chat-member-message.js";
import { adjustLivePaneHeight, clampLivePaneHeight, livePaneStatus, savedLivePaneHeight, selectedLivePane } from "../src/frontend/components/app/task-chat/task-chat.js";


const completed = { kind: "agent_turn" as const, id: "turn", role: "builder" as const, agent: { name: "Builder", avatarSeed: "builder" }, startedAt: "2026-08-23T00:00:00.000Z", finishedAt: "2026-08-23T00:00:40.000Z", status: "completed" as const, intro: "I will inspect the exact delivered commit.", events: [{ id: "command", at: "2026-08-23T00:00:10.000Z", kind: "command", text: "git status", exitCode: 0, status: "completed" as const }, { id: "message", at: "2026-08-23T00:00:11.000Z", kind: "message", text: "I found three in-scope blocking gaps." }, { id: "tool", at: "2026-08-23T00:00:12.000Z", kind: "tool_call", text: "read" }, { id: "update", at: "2026-08-23T00:00:13.000Z", kind: "agent_update", text: "The service now gathers all campaign routes." }, { id: "reasoning", at: "2026-08-23T00:00:14.000Z", kind: "thinking_summary", text: "Reasoning details" }, { id: "file", at: "2026-08-23T00:00:15.000Z", kind: "file_change", text: "Updated task-chat.ts", files: ["src/task-chat.ts"] }], summary: "The work is complete.", stats: { filesChanged: 1, additions: 12, deletions: 3 } };
const withoutIntro = Object.fromEntries(Object.entries(completed).filter(([key]) => key !== "intro")) as Omit<typeof completed, "intro">;
const withoutResult = Object.fromEntries(Object.entries(completed).filter(([key]) => key !== "intro" && key !== "summary")) as Omit<typeof completed, "intro" | "summary">;

describe("live pane dock sizing", () => {
  it("restores valid heights and clamps malformed or out-of-range storage values", () => {
    expect(savedLivePaneHeight("400")).toBe(400);
    expect(savedLivePaneHeight("100")).toBe(160);
    expect(savedLivePaneHeight("900")).toBe(720);
    expect(savedLivePaneHeight("invalid")).toBe(320);
    expect(savedLivePaneHeight(null)).toBe(320);
  });

  it("adjusts dock height in fixed clamped keyboard steps", () => {
    expect(clampLivePaneHeight(350)).toBe(350);
    expect(adjustLivePaneHeight(320, 1)).toBe(344);
    expect(adjustLivePaneHeight(160, -1)).toBe(160);
    expect(adjustLivePaneHeight(720, 1)).toBe(720);
  });
});

describe("task chat UI", () => {
  it("keeps the selected live pane through refreshes and falls back to the first pane", () => {
    const planner = { role: "planner", paneId: "pane-plan", agentName: "task-planner", status: "working", attachCommand: "herdr agent attach task-planner" };
    const builder = { role: "builder", paneId: "pane-build", agentName: "task-builder", status: "idle", attachCommand: "herdr agent attach task-builder" };
    const panes = [planner, builder];
    expect(selectedLivePane(panes, undefined)).toBe(planner);
    expect(selectedLivePane([...panes], "builder")).toBe(builder);
    expect(selectedLivePane([planner], "builder")).toBe(planner);
  });

  it("uses the pane response status for live pane status", () => {
    expect(livePaneStatus("working")).toEqual({ label: "Working", dotClass: "animate-pulse bg-emerald-500" });
    expect(livePaneStatus("awaiting_human")).toEqual({ label: "Awaiting human", dotClass: "bg-amber-500" });
    expect(livePaneStatus(null)).toEqual({ label: "Status unknown", dotClass: "bg-muted-foreground" });
  });

  it("keeps a completed final summary visible while progress stays collapsed", () => {
    const html = renderToStaticMarkup(createElement(ChatAgentTurn, { item: completed, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    expect(html).toContain("Worked for 40s");
    expect(html).toContain("+12 −3");
    expect(html).toContain("7 steps");
    expect(html).toContain("data-task-chat-execution-chain");
    expect(html).toMatch(/aria-expanded="false"/);
    expect(html).toContain("The work is complete.");
    expect(html).not.toContain("I will inspect the exact delivered commit.");
    expect(html).not.toContain("I found three in-scope blocking gaps.");
    expect(html).not.toContain("The service now gathers all campaign routes.");
    expect(html).not.toContain("git status");
    expect(html).not.toContain("Reasoning details");
    expect(html).not.toContain("Updated task-chat.ts");
    expect(html).not.toContain("data-task-chat-execution-group");
  });

  it("renders the outer closed chevron after duration, steps, and stats", () => {
    const html = renderToStaticMarkup(createElement(ChatAgentTurn, { item: completed, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    const trigger = html.match(/data-task-chat-execution-chain[^]*?<button[^]*?<\/button>/)?.[0] ?? "";
    expect(trigger.indexOf("Worked for 40s")).toBeLessThan(trigger.indexOf("7 steps"));
    expect(trigger.indexOf("7 steps")).toBeLessThan(trigger.indexOf("+12 −3"));
    expect(trigger.indexOf("+12 −3")).toBeLessThan(trigger.indexOf("lucide-chevron-right"));
  });

  it("omits clipped structured results when a durable summary exists", () => {
    const machine = "{\"kind\":\"delivery_review\",\"summary\":\"Machine result\",\"outcome\":\"blocking\",\"findings\":[";
    const item = { ...withoutIntro, events: [{ id: "machine", at: "2026-08-23T00:00:10.000Z", kind: "message", text: machine }, { id: "command", at: "2026-08-23T00:00:11.000Z", kind: "command", text: "pnpm test", exitCode: 0, status: "completed" as const }] };
    const html = renderToStaticMarkup(createElement(ChatAgentTurn, { item, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    expect(html).toContain("The work is complete.");
    expect(html).toContain("1 step");
    expect(html).not.toContain("delivery_review");
    expect(html).not.toContain("Machine result");
    expect(html).not.toContain("Thinking");
  });

  it("uses a decoded structured summary when the durable summary is absent", () => {
    const item = { ...withoutResult, events: [{ id: "machine", at: "2026-08-23T00:00:10.000Z", kind: "message", text: "{\"verdict\":\"revise\",\"summary\":\"Human \\\"quoted\\\" response\"}" }] };
    const html = renderToStaticMarkup(createElement(ChatAgentTurn, { item, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    expect(html).toContain("Human &quot;quoted&quot; response");
    expect(html).not.toContain("verdict");
  });

  it("omits versioned structured results without summaries", () => {
    const item = { ...withoutResult, events: [{ id: "machine", at: "2026-08-23T00:00:10.000Z", kind: "agent_update", text: "{\"version\":1,\"originalPlanRevision\":2}" }] };
    const html = renderToStaticMarkup(createElement(ChatAgentTurn, { item, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    expect(html).not.toContain("originalPlanRevision");
    expect(html).not.toContain("data-task-chat-agent-bubble");
    expect(html).not.toContain("data-task-chat-execution-group");
  });

  it("recovers a clipped top-level structured summary", () => {
    const item = { ...withoutResult, events: [{ id: "machine", at: "2026-08-23T00:00:10.000Z", kind: "agent_update", text: "{\"kind\":\"delivery_review\",\"summary\":\"Recovered response\",\"findings\":[" }] };
    const html = renderToStaticMarkup(createElement(ChatAgentTurn, { item, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    expect(html).toContain("Recovered response");
    expect(html).not.toContain("delivery_review");
  });

  it("renders a terminal final answer in the summary bubble instead of Thinking", () => {
    const item = { ...withoutResult, events: [{ id: "progress", at: "2026-08-23T00:00:10.000Z", kind: "message", text: "Still working" }, { id: "final", at: "2026-08-23T00:00:11.000Z", kind: "message", text: "**Final answer**", phase: "final_answer" as const }] };
    const html = renderToStaticMarkup(createElement(ChatAgentTurn, { item, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    expect(html).toContain("<strong>Final answer</strong>");
    expect(html).toContain("1 step");
    expect(html).not.toContain("Thinking");
  });

  it("renders a flat agent response container", () => {
    const html = renderToStaticMarkup(createElement(ChatAgentTurn, { item: completed, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    const responseClass = html.match(/<div[^>]*data-task-chat-agent-bubble[^>]*class="([^"]*)"/)?.[1];
    expect(html).toContain("The work is complete.");
    expect(responseClass).toBeDefined();
    expect(responseClass).not.toMatch(/\bborder\b|\bbg-muted\/40\b/);
  });

  it("prefers durable summaries over terminal final-answer fallbacks", () => {
    const item = { ...withoutIntro, events: [{ id: "final", at: "2026-08-23T00:00:11.000Z", kind: "message", text: "Fallback response", phase: "final_answer" as const }] };
    const html = renderToStaticMarkup(createElement(ChatAgentTurn, { item, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    expect(html).toContain("The work is complete.");
    expect(html).not.toContain("Fallback response");
    expect(html.match(/data-task-chat-agent-bubble/g)).toHaveLength(1);
  });

  it("promotes final answers independent of agent role without completing running turns", () => {
    for (const role of ["planner", "reviewer", "builder", "integrator"] as const) {
      const item = { ...withoutResult, role, finishedAt: null, status: "running" as const, events: [{ id: "final", at: "2026-08-23T00:00:11.000Z", kind: "message", text: `${role} result`, phase: "final_answer" as const }] };
      const html = renderToStaticMarkup(createElement(ChatAgentTurn, { item, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
      expect(html).toContain(`${role} result`);
      expect(html).toContain('data-task-chat-status="running"');
      expect(html).not.toContain("has finished");
    }
  });

  it("renders intro and every progress event as ordered flat thinking blocks", () => {
    const item = { ...completed, finishedAt: null, status: "running" as const, events: [
      { id: "command-one", at: "2026-08-23T00:00:10.000Z", kind: "command", text: "git status", exitCode: 0, status: "completed" as const },
      { id: "message", at: "2026-08-23T00:00:11.000Z", kind: "message", text: "I found three in-scope blocking gaps." },
      { id: "tool", at: "2026-08-23T00:00:12.000Z", kind: "tool_call", text: "read" },
      { id: "update", at: "2026-08-23T00:00:13.000Z", kind: "agent_update", text: "The service now gathers all campaign routes." },
      { id: "reasoning", at: "2026-08-23T00:00:14.000Z", kind: "thinking_summary", text: "Reasoning details" },
      { id: "command-two", at: "2026-08-23T00:00:15.000Z", kind: "command", text: "pnpm test", exitCode: 0, status: "completed" as const },
    ] };
    const html = renderToStaticMarkup(createElement(ChatAgentTurn, { item, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    const chain = html.match(/<ol data-task-chat-execution-group[^]*?<\/ol>/)?.[0] ?? "";
    expect(html.match(/data-task-chat-agent-bubble/g)).toHaveLength(1);
    expect(html.match(/data-task-chat-reasoning/g)).toHaveLength(4);
    expect(html).toContain("7 steps");
    expect(chain).toMatch(/I will inspect.*git status.*I found three.*read.*The service now.*Reasoning details.*pnpm test/s);
    expect(chain).not.toContain("data-task-chat-agent-bubble");
    expect(chain).not.toContain("rounded-[6px]");
    expect(html).not.toContain("border-l");
  });

  it("renders a running header, execution groups, composer reason, and markdown member body", () => {
    const running = { ...completed, finishedAt: null, status: "running" as const };
    const runningHtml = renderToStaticMarkup(createElement(ChatAgentTurn, { item: running, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    expect(runningHtml).toContain("lucide-chevron-down");
    expect(runningHtml).toContain("Working for");
    expect(runningHtml).toMatch(/aria-expanded="true"/);
    expect(runningHtml).toContain("git status");
    expect(runningHtml).toContain("read");
    expect(runningHtml).toContain("src/task-chat.ts");
    expect(renderToStaticMarkup(createElement(ChatComposer, { taskId: "task", phase: "planning", disabled: true, plannerAvailable: true, onSubmit: async () => undefined }))).toContain("disabled");
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
    expect(html).toContain("exit 1");
    expect(html).toContain("data-variant=\"destructive\"");
    expect(html).toContain("exec");
    expect(html).toContain("×3");
    expect(html).toContain("call-123");
    expect(html.match(/<li data-task-chat-tool-call[^]*?<\/li>/)?.[0]).not.toContain("aria-expanded");
    expect(html).toContain("<strong>Done</strong>");
  });

  it("renders completed patch rows as collapsed file disclosures without acknowledgements", () => {
    const item = { ...completed, finishedAt: null, status: "running" as const, events: [{ id: "patch", at: "2026-08-23T00:00:10.000Z", kind: "command", text: "Apply patch", status: "completed" as const, patch: { files: [{ path: "src/a.ts", operation: "Edit" as const, additions: 1, deletions: 1, rows: [{ kind: "deletion" as const, text: "old", oldLine: 2 }, { kind: "addition" as const, text: "new", newLine: 2 }] }] } }] };
    const html = renderToStaticMarkup(createElement(ChatAgentTurn, { item, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    expect(html).toContain("Edit");
    expect(html).toContain("src/a.ts");
    expect(html).toContain("+1");
    expect(html).toContain("−1");
    expect(html).toContain("lucide-file-pen-line");
    expect(html).toContain("lucide-chevron-right");
    expect(html).not.toContain("{}");
    expect(html).not.toContain(">old<");
  });

  it("opens running patches with literal diff rows and line number cells", () => {
    const item = { ...completed, finishedAt: null, status: "running" as const, events: [{ id: "patch", at: "2026-08-23T00:00:10.000Z", kind: "command", text: "Apply patch", status: "running" as const, patch: { files: [{ path: "src/<a>.ts", operation: "Edit" as const, additions: 1, deletions: 1, rows: [{ kind: "deletion" as const, text: "<old>", oldLine: 2 }, { kind: "addition" as const, text: "<new>", newLine: 2 }] }] } }] };
    const html = renderToStaticMarkup(createElement(ChatAgentTurn, { item, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    expect(html).toContain("data-task-chat-patch-diff");
    expect(html).toContain("&lt;old&gt;");
    expect(html).toContain("&lt;new&gt;");
    expect(html).toContain(">2</span><span");
    expect(html).toContain('>2</span><code');
  });

  it("uses checkpoint markers for terminal agent statuses", () => {
    const completedHtml = renderToStaticMarkup(createElement(ChatAgentTurn, { item: { ...completed, status: "completed", finishedAt: "2026-08-23T00:00:40.000Z" }, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    const failedHtml = renderToStaticMarkup(createElement(ChatAgentTurn, { item: { ...completed, status: "failed", finishedAt: "2026-08-23T00:00:40.000Z" }, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    const blockedHtml = renderToStaticMarkup(createElement(ChatAgentTurn, { item: { ...completed, status: "blocked", finishedAt: "2026-08-23T00:00:40.000Z" }, onOpenDiff: () => undefined, onLoadEvents: async () => undefined }));
    expect(completedHtml).toContain('data-task-chat-checkpoint-status="completed"');
    expect(completedHtml).toContain("Builder has finished");
    expect(failedHtml).toContain('data-task-chat-checkpoint-status="failed"');
    expect(failedHtml).toContain("Builder has failed");
    expect(failedHtml).toContain("text-destructive");
    expect(blockedHtml).toContain('data-task-chat-checkpoint-status="blocked"');
    expect(blockedHtml).toContain("Builder is blocked");
    expect(blockedHtml).toContain("text-amber-700");
    expect([completedHtml, failedHtml, blockedHtml].every((html) => html.includes("lucide-bookmark") && html.includes("h-px flex-1 bg-border"))).toBe(true);
  });
});
