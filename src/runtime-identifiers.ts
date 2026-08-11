export interface RuntimeIdentifiers {
  namespace: string;
  taskQueue: string;
  workflowPrefix: string;
  workerPrefix: string;
  buildId: string;
  temporalContainerName: string;
  temporalVolumeName: string;
  ownerLabel: string;
}

export function runtimeIdentifiers(installationId: string): RuntimeIdentifiers {
  return {
    namespace: `runtime-${installationId}`,
    taskQueue: `tasks-${installationId}`,
    workflowPrefix: `workflow-${installationId}`,
    workerPrefix: `worker-${installationId}`,
    buildId: `build-${installationId}-v1`,
    temporalContainerName: `temporal-${installationId}`,
    temporalVolumeName: `runtime-${installationId}-temporal-data`,
    ownerLabel: `runtime-${installationId}`,
  };
}

export function isLegacyDurableIdentifier(value: string): boolean {
  return /forge/i.test(value);
}
