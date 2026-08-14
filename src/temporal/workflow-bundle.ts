import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { bundleWorkflowCode, type WorkflowBundleWithSourceMap } from "@temporalio/worker";

let productionBundle: Promise<WorkflowBundleWithSourceMap> | undefined;

export const temporalDataConverter = {
  payloadConverterPath: fileURLToPath(new URL("./payload-converter.cjs", import.meta.url)),
};

function modulePath(name: string): string {
  return fileURLToPath(new URL(`./${name}.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url));
}

export function productionWorkflowBundleOptions(): {
  workflowsPath: string;
  payloadConverterPath: string;
  workflowInterceptorModules: string[];
} {
  return {
    workflowsPath: modulePath("workflows"),
    payloadConverterPath: modulePath("payload-converter"),
    workflowInterceptorModules: [modulePath("workflow-payload-interceptors")],
  };
}

export function buildProductionWorkflowBundle(): Promise<WorkflowBundleWithSourceMap> {
  productionBundle ??= bundleWorkflowCode(productionWorkflowBundleOptions());
  return productionBundle;
}

export function workflowBundleBuildId(installationId: string, bundle: Pick<WorkflowBundleWithSourceMap, "code">): string {
  return `build-${installationId}-${createHash("sha256").update(bundle.code).digest("hex").slice(0, 16)}`;
}

export function resetProductionWorkflowBundleForTests(): void {
  productionBundle = undefined;
}
