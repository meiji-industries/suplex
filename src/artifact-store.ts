import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class CompanyArtifactStore {
  constructor(private readonly root: string) {}
  companyRoot(companyId: string) { if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(companyId)) throw new Error("invalid company"); return resolve(this.root, companyId) }
  async ensureCompanyRoot(companyId: string) { const root = this.companyRoot(companyId); await mkdir(root, { recursive: true }); return root }
  private path(companyId: string, filename: string) { const root = this.companyRoot(companyId), path = resolve(root, filename), rel = relative(root, path); if (!filename || isAbsolute(filename) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("invalid path"); return path }
  async put(companyId: string, filename: string, contents: Uint8Array | string) { const path = this.path(companyId, filename); await mkdir(resolve(path, ".."), { recursive: true }); await writeFile(path, contents, { flag: "wx" }); return path }
  async read(companyId: string, filename: string) { return readFile(this.path(companyId, filename)) }
}
