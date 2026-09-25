// Writes the static agent artifacts the Rust backend serves from the TypeScript
// source of truth. `--check` exits 1 when a committed artifact differs.
import { readFileSync, writeFileSync } from "node:fs";

import Fastify from "fastify";

import { agentApiRuntimeOpenApi } from "../src/http/contracts/agent-api.js";
import discovery from "../src/http/routes/discovery.js";
import { SUPLEX_MCP_TOOLS } from "../src/integrations/suplex/mcp-bridge.js";

const app = Fastify();
await app.register(discovery, {});
const served = async (url: string): Promise<string> => (await app.inject({ method: "GET", url })).body;
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const artifacts: Record<string, string> = {
  "rust/src/http/routes/agent_api_openapi.json": json(agentApiRuntimeOpenApi()),
  "rust/src/integrations/suplex/tools.json": json(SUPLEX_MCP_TOOLS),
  "rust/src/http/routes/discovery/llms.txt": await served("/llms.txt"),
  "rust/src/http/routes/discovery/api-catalog.json": json(JSON.parse(await served("/.well-known/suplex/api-catalog.json"))),
  "rust/src/http/routes/discovery/agent-skills.json": json(JSON.parse(await served("/.well-known/suplex/agent-skills.json"))),
};
await app.close();

const check = process.argv.includes("--check");
const stale = Object.entries(artifacts).filter(([path, content]) => {
  let current = "";
  try { current = readFileSync(path, "utf8"); } catch { /* missing */ }
  return current !== content;
});
if (check) {
  if (stale.length) {
    console.error(`Stale Rust agent artifacts:\n${stale.map(([path]) => path).join("\n")}`);
    process.exit(1);
  }
  console.log("Rust agent artifacts match the TypeScript source.");
} else {
  for (const [path, content] of stale) writeFileSync(path, content);
  console.log(`Wrote ${stale.length} artifact(s).`);
}
