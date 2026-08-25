import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

export async function ensureResultSchema(runtimeRoot: string, name: string, schema: z.ZodType): Promise<string> {
  const directory = join(runtimeRoot, "schemas");
  const path = join(directory, `${name}.schema.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(z.toJSONSchema(schema), null, 2)}\n`, { mode: 0o600 });
  return path;
}
