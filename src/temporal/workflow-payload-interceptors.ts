import type { WorkflowInboundCallsInterceptor, WorkflowInterceptorsFactory, WorkflowOutboundCallsInterceptor } from "@temporalio/workflow";

import { assertEncodedPayloadBoundary, PAYLOAD_POLICY } from "./policy.js";

class PayloadInboundInterceptor implements WorkflowInboundCallsInterceptor {
  execute(input: Parameters<NonNullable<WorkflowInboundCallsInterceptor["execute"]>>[0], next: Parameters<NonNullable<WorkflowInboundCallsInterceptor["execute"]>>[1]): Promise<unknown> {
    assertEncodedPayloadBoundary("workflowStartInput", input.args, PAYLOAD_POLICY.workflowStartInput);
    return next(input).then((result) => {
      assertEncodedPayloadBoundary("workflowOrUpdateResult", [result], PAYLOAD_POLICY.workflowOrUpdateResult);
      return result;
    });
  }

  handleUpdate(input: Parameters<NonNullable<WorkflowInboundCallsInterceptor["handleUpdate"]>>[0], next: Parameters<NonNullable<WorkflowInboundCallsInterceptor["handleUpdate"]>>[1]): Promise<unknown> {
    assertEncodedPayloadBoundary("updateOrSignalArguments", input.args, PAYLOAD_POLICY.updateOrSignalArguments);
    return next(input).then((result) => {
      assertEncodedPayloadBoundary("workflowOrUpdateResult", [result], PAYLOAD_POLICY.workflowOrUpdateResult);
      return result;
    });
  }

  validateUpdate(input: Parameters<NonNullable<WorkflowInboundCallsInterceptor["validateUpdate"]>>[0], next: Parameters<NonNullable<WorkflowInboundCallsInterceptor["validateUpdate"]>>[1]): void {
    assertEncodedPayloadBoundary("updateOrSignalArguments", input.args, PAYLOAD_POLICY.updateOrSignalArguments);
    next(input);
  }

  handleSignal(input: Parameters<NonNullable<WorkflowInboundCallsInterceptor["handleSignal"]>>[0], next: Parameters<NonNullable<WorkflowInboundCallsInterceptor["handleSignal"]>>[1]): Promise<void> {
    assertEncodedPayloadBoundary("updateOrSignalArguments", input.args, PAYLOAD_POLICY.updateOrSignalArguments);
    return next(input);
  }

  handleQuery(input: Parameters<NonNullable<WorkflowInboundCallsInterceptor["handleQuery"]>>[0], next: Parameters<NonNullable<WorkflowInboundCallsInterceptor["handleQuery"]>>[1]): Promise<unknown> {
    assertEncodedPayloadBoundary("queryArguments", input.args, PAYLOAD_POLICY.queryArguments);
    return next(input).then((result) => {
      assertEncodedPayloadBoundary("queryResult", [result], PAYLOAD_POLICY.queryResult);
      return result;
    });
  }
}

class PayloadOutboundInterceptor implements WorkflowOutboundCallsInterceptor {
  scheduleActivity(input: Parameters<NonNullable<WorkflowOutboundCallsInterceptor["scheduleActivity"]>>[0], next: Parameters<NonNullable<WorkflowOutboundCallsInterceptor["scheduleActivity"]>>[1]): Promise<unknown> {
    assertEncodedPayloadBoundary("activityArguments", input.args, PAYLOAD_POLICY.activityArguments);
    return next(input).then((result) => {
      assertEncodedPayloadBoundary("activityResult", [result], PAYLOAD_POLICY.activityResult);
      return result;
    });
  }

  continueAsNew(input: Parameters<NonNullable<WorkflowOutboundCallsInterceptor["continueAsNew"]>>[0], next: Parameters<NonNullable<WorkflowOutboundCallsInterceptor["continueAsNew"]>>[1]): Promise<never> {
    assertEncodedPayloadBoundary("continueAsNewInput", input.args, PAYLOAD_POLICY.continueAsNewInput);
    return next(input);
  }
}

export function interceptors(): ReturnType<WorkflowInterceptorsFactory> {
  return { inbound: [new PayloadInboundInterceptor()], outbound: [new PayloadOutboundInterceptor()] };
}
