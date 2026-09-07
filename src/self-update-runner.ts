import { fileURLToPath } from "node:url";

import { StructuredLogger } from "./logging.js";
import { runSelfUpdateFromEnvironment } from "./self-update.js";

function operationIdFromArguments(): string {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--operation" || !/^[0-9a-f-]{36}$/i.test(args[1] ?? "")) {
    throw new Error("The self-update runner requires one operation ID");
  }
  return args[1]!;
}

async function main(): Promise<void> {
  await runSelfUpdateFromEnvironment(operationIdFromArguments());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    new StructuredLogger().error("Forge self-update failed", {}, { error: error instanceof Error ? error.message : "unknown error" });
    process.exitCode = 1;
  });
}
