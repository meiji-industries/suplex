import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** True when this module is the script node was started with. Node resolves symlinks in import.meta.url but not in argv[1], so compare real paths. */
export function isEntrypoint(moduleUrl: string): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(script);
  } catch {
    return false;
  }
}
