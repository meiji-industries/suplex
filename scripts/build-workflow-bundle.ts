import { createHash } from "node:crypto";

import { buildProductionWorkflowBundle } from "../src/temporal/workflow-bundle.js";
import { auditProductionWorkflowBundle } from "../src/temporal/replay.js";

const bundle = await buildProductionWorkflowBundle();
await auditProductionWorkflowBundle(bundle);
const hash = createHash("sha256").update(bundle.code, "utf8").digest("hex");
console.log(JSON.stringify({ bundleSha256: hash, bytes: Buffer.byteLength(bundle.code, "utf8") }));
