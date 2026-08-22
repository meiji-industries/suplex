import type { ArtifactStore } from "./artifacts.js";
import type { ForgeDatabase } from "./database.js";
import { EvidenceManifestSchema } from "./developer-contracts.js";
import { jsonRequired } from "./task-utils.js";


type ArtifactRow = { storagePath: string; sha256: string };

function readJson(artifacts: ArtifactStore, companyId: string, artifact: ArtifactRow): unknown | null {
  try { return jsonRequired(artifacts.getArtifactSync({ companyId, storagePath: artifact.storagePath, sha256: artifact.sha256 }).toString("utf8")) as unknown; } catch { return null; }
}

export function developerVerificationProjection(database: ForgeDatabase, artifacts: ArtifactStore, companyId: string, manifestArtifactId: string | null): { verificationCommands: Array<{ stepNumber: number; commands: string[] }>; verificationResults: string[] } {
  const artifact = (id: string) => database.authQuery((db) => db.prepare("SELECT storage_path AS storagePath, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'developer-evidence-manifest'").get(id, companyId) as ArtifactRow | undefined);
  const manifest = manifestArtifactId ? artifact(manifestArtifactId) : undefined;
  const parsedManifest = manifest ? EvidenceManifestSchema.safeParse(readJson(artifacts, companyId, manifest)) : undefined;
  return { verificationCommands: parsedManifest?.success ? parsedManifest.data.verificationCommands : [], verificationResults: [] };
}
