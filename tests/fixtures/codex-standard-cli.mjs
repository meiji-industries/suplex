#!/usr/bin/env node
// Deterministic Codex process stand-in for the isolated Standard browser journey.
// It exercises the real Root MCP and Worker Git path without contacting a model.
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

const line = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const phase = process.env.SUPLEX_DETERMINISTIC_PHASE ?? "deliver";

async function inputPrompt() {
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  return prompt;
}

async function pauseWorker() {
  if (phase !== "restart" && phase !== "cancel") return;
  const directory = process.env.SUPLEX_DETERMINISTIC_CONTROL_DIR;
  if (!directory) throw new Error("Deterministic control directory is missing");
  await writeFile(join(directory, "paused"), "worker\n");
  const release = join(directory, "release");
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    if (await access(release).then(() => true, () => false)) return;
    await setTimeout(100);
  }
  throw new Error("Deterministic Worker pause timed out");
}

async function command(executable, args, options = {}) {
  const child = spawn(executable, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  child.stdout.on("data", chunk => output.push(chunk));
  child.stderr.resume();
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) throw new Error(`${executable} ${args[0] ?? ""} exited ${code}`);
  return Buffer.concat(output).toString();
}

async function mcpCall(binding, name, args) {
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "deterministic-codex-fixture", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
  ];
  const child = spawn(binding.server.command, binding.server.args, { stdio: ["pipe", "pipe", "pipe"] });
  const output = [];
  child.stdout.on("data", chunk => output.push(chunk));
  child.stderr.resume();
  child.stdin.end(`${requests.map(request => JSON.stringify(request)).join("\n")}\n`);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) throw new Error(`MCP ${name} exited ${code}`);
  const responses = Buffer.concat(output).toString().split("\n").filter(Boolean).map(row => JSON.parse(row));
  return responses.find(response => response.id === 2)?.result;
}

async function rootTool(binding, kind, fields = {}) {
  const result = await mcpCall(binding, "suplex_root", { kind, ...fields });
  if (result?.isError !== false || !result.structuredContent) {
    throw new Error(`Root MCP ${kind} failed: ${JSON.stringify(result?.content ?? null)}`);
  }
  return result.structuredContent;
}

async function root(prompt) {
  const binding = JSON.parse(await readFile(process.env.SUPLEX_ROOT_BINDING, "utf8"));
  line({ type: "thread.started", thread_id: `fixture-root-${binding.root.sessionId}` });
  const observed = await rootTool(binding, "observe");
  if (observed.control.workflow !== "standard") {
    await workflowRoot(binding, observed);
  } else if (phase === "answer" && !observed.workerResult && !prompt.includes("Proceed: Make the local change")) {
    await rootTool(binding, "ask_human", {
      question: "May I continue this local fixture?",
      options: [
        { label: "Proceed", description: "Make the local change", recommended: true },
        { label: "Stop", description: "Leave the task unchanged", recommended: false },
      ],
    });
    line({ type: "item.completed", item: { id: "root_question", type: "agent_message", text: "Asked for the specific task decision." } });
  } else if (!observed.workerResult) {
    await rootTool(binding, "delegate_worker", {
      plan: "Append the requested README line, run the project test, and commit it locally.",
      acceptanceCriteria: ["README contains the requested line", "Project test passes", "Change is committed"],
      instruction: "Append `Verified by Suplex Standard task.` to README.md, run pnpm test, and commit the change. Do not deliver; the Root will review and request delivery.",
    });
    line({ type: "item.completed", item: { id: "root_delegate", type: "agent_message", text: "Assigned the local change and test to the Worker." } });
  } else {
    const evidence = await rootTool(binding, "read_worker_evidence", { turnId: observed.workerResult.turnId });
    if (!evidence || !JSON.stringify(evidence).includes("pnpm test")) throw new Error("Worker test evidence is missing");
    const head = (await command("git", ["rev-parse", "HEAD"])).trim();
    await rootTool(binding, "request_delivery", { operation: "complete_local_work", expectedHead: head });
    line({ type: "item.completed", item: { id: "root_delivery", type: "agent_message", text: "Reviewed Worker evidence and completed local delivery." } });
  }
  line({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } });
}

const assignment = {
  plan: "Append the requested README line, run the project test, and commit it locally.",
  acceptanceCriteria: ["README contains the requested line", "Project test passes", "Change is committed"],
  instruction: "Append `Verified by Suplex Standard task.` to README.md, run pnpm test, and commit the change. Do not deliver; the Root will review and request delivery.",
};

// One Coordinator step per turn for each non-Standard workflow, decided from observed task state.
async function workflowRoot(binding, observed) {
  const say = (id, text) => line({ type: "item.completed", item: { id, type: "agent_message", text } });
  const deliver = async () => {
    const diff = await rootTool(binding, "request_delivery", { operation: "inspect_delivery_diff" });
    if (!diff.evidenceDirectory || !diff.files.includes("README.md")) throw new Error("Workflow delivery inspection is missing its evidence");
    const head = (await command("git", ["rev-parse", "HEAD"])).trim();
    await rootTool(binding, "request_delivery", { operation: "complete_local_work", expectedHead: head, review: { baseSha: diff.baseSha, headSha: diff.headSha, files: diff.files, commits: diff.commits } });
    say("root_delivery", "Reviewed the workflow result and completed local delivery.");
  };
  const workers = observed.workers ?? [];
  const results = observed.results ?? {};
  const built = workers.some(session => session.advisorRole === null && results[session.id]?.state === "completed");
  const workflow = observed.control.workflow;
  if (workflow === "direct_build") {
    if (built) return deliver();
    await rootTool(binding, "delegate_worker", { mode: "direct", acceptanceCriteria: assignment.acceptanceCriteria, instruction: assignment.instruction });
    return say("root_delegate", "Assigned the objective to the Worker in direct mode.");
  }
  if (workflow === "independent_review") {
    if (observed.control.workflowState.reviews.length) return deliver();
    if (built) {
      await rootTool(binding, "delegate_advisor", { role: "reviewer", brief: `${assignment.plan}\nAcceptance criteria: ${assignment.acceptanceCriteria.join("; ")}` });
      return say("root_review", "Requested the Reviewer for the current range.");
    }
    await rootTool(binding, "delegate_worker", assignment);
    return say("root_delegate", "Assigned the planned change to the Worker.");
  }
  if (workflow === "competing_plans") {
    if (built) return deliver();
    const planners = ["planner_a", "planner_b"].map(role => workers.find(session => session.advisorRole === role));
    if (planners.every(Boolean)) {
      const turns = planners.map(session => results[session.id]?.turnId);
      if (!turns.every(Boolean)) return say("root_wait", "Waiting for both plans.");
      await rootTool(binding, "delegate_worker", { ...assignment, plan: `Combined plan from Plan A and Plan B: ${assignment.plan}`, candidateTurnIds: turns });
      return say("root_delegate", "Combined both plans and assigned the Worker.");
    }
    await rootTool(binding, "delegate_planners");
    return say("root_planners", "Requested Plan A and Plan B.");
  }
  throw new Error(`The deterministic stand-in has no ${workflow} Coordinator`);
}

const advisorReports = {
  reviewer: { approved: true, blockingFindings: [], verification: "passed", verificationSummary: "The Worker ran pnpm test on this head and it passed.", summary: "The README change meets the objective." },
  planner_a: { summary: "Append the README line, run pnpm test, and commit." },
  planner_b: { summary: "Add the README line with one commit after pnpm test passes." },
  rater: { rating: 9, blockingFindings: [], verification: "passed", verificationSummary: "The checks passed on this head.", summary: "Ready to merge." },
};

// Advisors are read-only: they submit one structured report through the Suplex Advisor bridge.
async function advisor() {
  const binding = JSON.parse(await readFile(process.env.SUPLEX_ADVISOR_BINDING, "utf8"));
  line({ type: "thread.started", thread_id: `fixture-advisor-${binding.role}-${process.pid}` });
  const report = advisorReports[binding.role];
  const result = await mcpCall(binding, "submit_report", report);
  if (result?.isError !== false) throw new Error(`Advisor report was rejected: ${JSON.stringify(result?.content ?? null)}`);
  line({ type: "item.completed", item: { id: "advisor_report", type: "mcp_tool_call", server: "suplex_advisor", tool: "submit_report", arguments: report, result, status: "completed" } });
  line({ type: "item.completed", item: { id: "advisor_summary", type: "agent_message", text: report.summary } });
  line({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } });
}

async function worker() {
  line({ type: "thread.started", thread_id: `fixture-worker-${process.pid}` });
  await pauseWorker();
  const readme = await readFile("README.md", "utf8");
  const addition = "Verified by Suplex Standard task.";
  if (!readme.includes(addition)) await writeFile("README.md", `${readme.replace(/\n?$/, "\n")}${addition}\n`);
  line({ type: "item.started", item: { id: "worker_test", type: "command_execution", command: "pnpm test", status: "in_progress" } });
  const testOutput = await command("pnpm", ["test"]);
  line({ type: "item.completed", item: { id: "worker_test", type: "command_execution", command: "pnpm test", aggregated_output: testOutput, exit_code: 0, status: "completed" } });
  await command("git", ["add", "README.md"]);
  await command("git", ["commit", "-m", "Append verified README line"], { env: {
    ...process.env,
    GIT_AUTHOR_NAME: "Suplex fixture",
    GIT_AUTHOR_EMAIL: "suplex-fixture@example.invalid",
    GIT_COMMITTER_NAME: "Suplex fixture",
    GIT_COMMITTER_EMAIL: "suplex-fixture@example.invalid",
  } });
  line({ type: "item.completed", item: { id: "worker_result", type: "agent_message", text: "README line committed after pnpm test passed." } });
  line({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } });
}

try {
  const prompt = await inputPrompt();
  // The Rust harness passes Root capability only to Root, including on resume.
  if (process.env.SUPLEX_ROOT_BINDING && process.env.SUPLEX_ROOT_TOKEN) await root(prompt);
  else if (process.env.SUPLEX_ADVISOR_BINDING && process.env.SUPLEX_ADVISOR_TOKEN) await advisor();
  else await worker();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  line({ type: "turn.failed", error: { message } });
  process.exitCode = 1;
}
