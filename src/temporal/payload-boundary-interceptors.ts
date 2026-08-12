import type { WorkflowClientInterceptor } from "@temporalio/client";
import type { ActivityInterceptorsFactory } from "@temporalio/worker";

import { assertEncodedPayloadBoundary, PAYLOAD_POLICY } from "./policy.js";

export const clientPayloadInterceptor: WorkflowClientInterceptor = {
  startWithDetails: async (input, next) => {
    assertEncodedPayloadBoundary("workflowStartInput", input.options.args, PAYLOAD_POLICY.workflowStartInput);
    assertEncodedPayloadBoundary("memo", Object.values(input.options.memo ?? {}), PAYLOAD_POLICY.memo);
    assertEncodedPayloadBoundary("searchAttributes", Object.values(input.options.searchAttributes ?? {}), PAYLOAD_POLICY.searchAttributes);
    return next(input);
  },
  startUpdate: async (input, next) => {
    assertEncodedPayloadBoundary("updateOrSignalArguments", input.args, PAYLOAD_POLICY.updateOrSignalArguments);
    return next(input);
  },
  signal: async (input, next) => {
    assertEncodedPayloadBoundary("updateOrSignalArguments", input.args, PAYLOAD_POLICY.updateOrSignalArguments);
    return next(input);
  },
  query: async (input, next) => {
    assertEncodedPayloadBoundary("queryArguments", input.args, PAYLOAD_POLICY.queryArguments);
    const result = await next(input);
    assertEncodedPayloadBoundary("queryResult", [result], PAYLOAD_POLICY.queryResult);
    return result;
  },
};

export const activityPayloadInterceptors: ActivityInterceptorsFactory[] = [() => ({
  inbound: {
    async execute(input, next) {
      assertEncodedPayloadBoundary("activityArguments", input.args, PAYLOAD_POLICY.activityArguments);
      const result = await next(input);
      assertEncodedPayloadBoundary("activityResult", [result], PAYLOAD_POLICY.activityResult);
      return result;
    },
  },
})];
