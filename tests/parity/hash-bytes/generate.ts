import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentApiTaskCommandBodySchema, AgentApiTaskCreateBodySchema } from "../../../src/http/contracts/agent-api.js";
import { TaskInputSchema } from "../../../src/tasks/contracts.js";
import { taskRequestHash } from "../../../src/tasks/repository.js";

const directory = fileURLToPath(new URL(".", import.meta.url));
const creator = { kind: "agent" as const, id: "agent-1" };
const task = TaskInputSchema.parse({ projectId: "project-1", title: "  A task  ", idempotencyKey: "task-key-001" });
const legacy = Object.fromEntries(Object.entries(task).filter(([key]) => !["workflow", "advisorProfileIds", "dependsOn", "blockedByPullRequests"].includes(key)));
const repositoryValue = { input: legacy, creator };
const commandValue = AgentApiTaskCommandBodySchema.parse({ command: "send_task_note", revision: "revision-1", idempotencyKey: "command-001", note: "  hello  " });
const agentInput = AgentApiTaskCreateBodySchema.parse({ projectId: "project-1", title: "  A task  ", idempotencyKey: "agent-key-001", dryRun: true, extra: { b: 2, a: 1 } });
const request = Object.fromEntries(Object.entries(agentInput).filter(([key]) => key !== "dryRun"));
const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sort(entry)])) : value;
const agentValue = sort({ input: request, creator });
const revisionValue = { value: { id: "task-1", status: "backlog", queue: { waitingOn: [] }, title: "A task", archived: false }, commandRevision: 3 };
const cases = {
  repository_request: { site: "src/tasks/repository.ts:38", inputJson: JSON.stringify(repositoryValue), encoding: "hex" },
  agent_command: { site: "src/tasks/tasks.ts:383", inputJson: JSON.stringify(commandValue), encoding: "hex" },
  agent_create: { site: "src/tasks/tasks.ts:984", inputJson: JSON.stringify(agentValue), encoding: "hex" },
  task_revision: { site: "src/tasks/tasks.ts:1050", inputJson: JSON.stringify(revisionValue), encoding: "base64url" },
  numeric_keys_and_floats: { site: "agent_create passthrough edge", inputJson: '{"2":"two","1":"one","small":0.000001,"tiny":0.0000001,"large":1e21,"negativeZero":-0,"text":"line\\nseparator\\u2028"}', encoding: "hex" },
  astral_string: { site: "task title and note edge", inputJson: '{"title":"😀","note":"💩","length":2}', encoding: "hex" },
  large_numbers: { site: "agent_create passthrough finite integer edge", inputJson: '{"beyondSafe":9007199254740993,"maxUnsigned":18446744073709551615}', encoding: "hex" },
} as const;
const check = process.argv.includes("--check");
if (!check) await mkdir(directory, { recursive: true });
for (const [name, example] of Object.entries(cases)) {
  const bytes = JSON.stringify(JSON.parse(example.inputJson));
  const digest = createHash("sha256").update(bytes).digest(example.encoding as "hex" | "base64url");
  if (name === "repository_request" && taskRequestHash(task, creator) !== digest) throw new Error("Repository hash fixture does not match the live code");
  const content = `${JSON.stringify({ ...example, bytes, digest }, null, 2)}\n`;
  const path = join(directory, `${name}.json`);
  if (check) {
    if (await readFile(path, "utf8") !== content) throw new Error(`Stale hash fixture: ${path}`);
  } else await writeFile(path, content);
}
console.log(`${check ? "Checked" : "Generated"} ${Object.keys(cases).length} JSON.stringify byte fixtures.`);
