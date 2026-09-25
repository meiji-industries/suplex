// On-demand source oracle for the Rust store test's isolated SQLite snapshot.
import { SuplexDatabase } from "../../src/platform/database.js";
import { TaskControlStore } from "../../src/coordination/root-session-store.js";

const [path, taskId, oldSessionId] = process.argv.slice(2);
if (!path || !taskId || !oldSessionId) throw new Error("Expected database, task, and Root session");
const database = new SuplexDatabase(path, { migrate: false });
try {
  const store = new TaskControlStore(database);
  const request = {
    sessionId: oldSessionId,
    rootProfileId: "alternate-root",
    handoff: "Check the failed provider.",
    resume: true,
    questionId: "question-current",
  } as const;
  const first = store.replaceCoordinator(taskId, request);
  const firstTurn = store.pendingTurns(first.id)[0]!;
  const replay = store.replaceCoordinator(taskId, request);
  if (replay.id !== first.id) throw new Error("Coordinator replay created another session");
  const second = store.replaceCoordinator(taskId, {
    sessionId: first.id,
    rootProfileId: "alternate-root",
    resume: false,
  });
  const secondTurn = store.pendingTurns(second.id)[0]!;
  process.stdout.write(JSON.stringify({
    firstPrompt: firstTurn.promptText,
    firstHash: firstTurn.promptHash,
    secondPrompt: secondTurn.promptText,
    secondHash: secondTurn.promptHash,
  }));
} finally {
  database.close();
}
