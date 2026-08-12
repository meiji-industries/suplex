import { fileURLToPath } from "node:url";

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

export function resetProductionWorkflowBundleForTests(): void {
  productionBundle = undefined;
}
