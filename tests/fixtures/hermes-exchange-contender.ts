import { dirname } from "node:path";

import { AuthService } from "../../src/auth.js";
import { createTestConfig } from "../../src/config.js";
import { ForgeDatabase } from "../../src/database.js";
import { HermesAgentFailure, HermesAgentService } from "../../src/hermes-agents.js";

const [databasePath, pairingCode, profileId] = process.argv.slice(2);
if (!databasePath || !pairingCode || !profileId) throw new Error("database path, pairing code, and profile ID are required");

const database = new ForgeDatabase(databasePath);
const auth = new AuthService(database, createTestConfig(dirname(databasePath), { databasePath }));
const service = new HermesAgentService(database, auth);

process.stdout.write("ready\n");
process.stdin.once("data", () => {
  try {
    service.exchange({ pairingCode, profileId });
    process.stdout.write(JSON.stringify({ outcome: "success" }) + "\n");
  } catch (error) {
    if (error instanceof HermesAgentFailure) {
      process.stdout.write(JSON.stringify({ outcome: "failure", statusCode: error.statusCode, code: error.code, message: error.publicMessage }) + "\n");
    } else {
      process.stdout.write(JSON.stringify({ outcome: "failure", statusCode: 500, code: "unexpected", message: "unexpected" }) + "\n");
    }
  } finally {
    database.close();
  }
});
