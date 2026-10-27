import { expect, test } from "vitest";

import { humanMessage } from "../features/tasks/task-work.js";

test("a human answer and note show the person who wrote them", () => {
  const chris = { id: "user_chris", name: "Chris", avatarSeed: "chris" };
  const answer = JSON.stringify({ question: "Use main?", answer: "Yes" });
  expect(humanMessage(answer, chris, "user_adam")).toEqual({ author: "Chris", text: "Yes", user: { id: "user_chris", name: "Chris", seed: "chris" } });
  expect(humanMessage(answer, chris, "user_chris")).toEqual({ author: "You", text: "Yes", user: { id: "user_chris", name: "Chris", seed: "chris" } });
  expect(humanMessage("Human note:\nCheck the logs", chris, "user_adam")).toMatchObject({ author: "Chris", text: "Check the logs" });
  // An earlier message without a recorded author is never shown as the viewer's.
  expect(humanMessage(answer, undefined, "user_adam")).toEqual({ author: "User", text: "Yes" });
  expect(humanMessage("Human note:\nCheck the logs")).toEqual({ author: "User", text: "Check the logs" });
  expect(humanMessage("Agent note (agent_1):\nSkip the tests")).toEqual({ author: "Agent note", text: "Skip the tests", agentId: "agent_1" });
});

test("an agent answer names the agent and the granting user", () => {
  const prompt = JSON.stringify({
    question: "Use main?",
    answer: "Main: Use main",
    answeredBy: { agentId: "agent_1", agentName: "Hermes", userId: "user_1", userName: "Ada" },
  });
  expect(humanMessage(prompt)).toEqual({ author: "Answered by Hermes for Ada", text: "Main: Use main", user: { id: "user_1", name: "Ada" } });
});

test("other Coordinator prompts are not shown as answers", () => {
  expect(humanMessage(JSON.stringify({ question: "Use main?", answer: "Yes", extra: 1 }))).toBeNull();
  expect(humanMessage(JSON.stringify({ question: "Limit?", decision: { kind: "cancel_task" } }))).toBeNull();
  expect(humanMessage("Worker result receipt r1.")).toBeNull();
});
