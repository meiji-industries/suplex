export interface RuntimeIdentifiers {
  namespace: string;
  taskQueue: string;
  workflowPrefix: string;
  workerPrefix: string;
  buildId: string;
  ownerLabel: string;
}

export function runtimeIdentifiers(installationId: string): RuntimeIdentifiers {
  return {
    namespace: `runtime-${installationId}`,
    taskQueue: `tasks-${installationId}`,
    workflowPrefix: `workflow-${installationId}`,
    workerPrefix: `worker-${installationId}`,
    buildId: `build-${installationId}-v1`,
    ownerLabel: `runtime-${installationId}`,
  };
}
