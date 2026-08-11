import { access, constants, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { CompanyIdSchema } from "./schemas.js";

function validateRelativePath(filename: string): string[] {
  if (!filename || isAbsolute(filename) || filename.includes("\\")) {
    throw new Error("Artifact path must be relative to the company root");
  }
  const segments = filename.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Artifact path contains an unsafe segment");
  }
  return segments;
}

async function rejectSymlinkPath(root: string, segments: string[]): Promise<void> {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error("Artifact path cannot traverse a symbolic link");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return;
    }
  }
}

export class CompanyArtifactStore {
  constructor(private readonly baseRoot: string) {}

  companyRoot(companyId: string): string {
    const validatedCompanyId = CompanyIdSchema.parse(companyId);
    const root = resolve(this.baseRoot, validatedCompanyId);
    const escaped = relative(resolve(this.baseRoot), root).startsWith("..");
    if (escaped) {
      throw new Error("Company artifact root escaped the configured base root");
    }
    return root;
  }

  async ensureCompanyRoot(companyId: string): Promise<string> {
    const root = this.companyRoot(companyId);
    await mkdir(root, { recursive: true });
    await rejectSymlinkPath(resolve(this.baseRoot), [CompanyIdSchema.parse(companyId)]);
    return root;
  }

  async put(companyId: string, filename: string, contents: Uint8Array | string): Promise<string> {
    const root = await this.ensureCompanyRoot(companyId);
    const segments = validateRelativePath(filename);
    await rejectSymlinkPath(root, segments.slice(0, -1));
    const destination = resolve(root, ...segments);
    if (relative(root, destination).startsWith("..")) {
      throw new Error("Artifact path escaped the company root");
    }
    await mkdir(resolve(destination, ".."), { recursive: true });
    await rejectSymlinkPath(root, segments);
    await writeFile(destination, contents, { flag: "wx" });
    return destination;
  }

  async read(companyId: string, filename: string): Promise<Buffer> {
    const root = this.companyRoot(companyId);
    const segments = validateRelativePath(filename);
    await access(root, constants.R_OK);
    await rejectSymlinkPath(root, segments);
    const destination = resolve(root, ...segments);
    if (relative(root, destination).startsWith("..")) {
      throw new Error("Artifact path escaped the company root");
    }
    return readFile(destination);
  }
}
