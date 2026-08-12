import { parentPort, workerData } from "node:worker_threads";

import { CapacityManager } from "../src/capacity.js";
import { ForgeDatabase } from "../src/database.js";

const input = workerData as { databasePath: string; requestId: string; capacity: number; gate: SharedArrayBuffer };
const gate = new Int32Array(input.gate);
parentPort?.postMessage({ type: "ready" });
Atomics.wait(gate, 0, 0);
const database = new ForgeDatabase(input.databasePath);
try {
  const capacity = new CapacityManager(database, { externalTurnCapacity: input.capacity });
  let result = capacity.tryAcquire(input.requestId, 0);
  for (let attempt = 0; attempt < 20 && result.status === "queued"; attempt += 1) {
    Atomics.wait(gate, 0, 1, 25);
    result = capacity.tryAcquire(input.requestId, 0);
  }
  parentPort?.postMessage({ type: "result", status: result.status, acquired: result.acquired });
} finally {
  database.close();
}
