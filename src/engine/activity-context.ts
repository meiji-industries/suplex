import { AsyncLocalStorage } from "node:async_hooks";

export interface ActivityExecutionContext {
  signal: AbortSignal;
  heartbeat(details?: unknown): void;
  log: { info(message: string, attributes?: unknown): void; warn(message: string, attributes?: unknown): void; error(message: string, attributes?: unknown): void; debug(message: string, attributes?: unknown): void };
}

const storage = new AsyncLocalStorage<ActivityExecutionContext>();

export const activityContext = {
  current(): ActivityExecutionContext {
    const current = storage.getStore();
    if (!current) throw new Error("No activity is currently executing");
    return current;
  },
  run<T>(context: ActivityExecutionContext, operation: () => T): T {
    return storage.run(context, operation);
  },
};

export const Context = {
  current() {
    const current = activityContext.current();
    return { cancellationSignal: current.signal, heartbeat: current.heartbeat, log: current.log, ...current.log };
  },
};
