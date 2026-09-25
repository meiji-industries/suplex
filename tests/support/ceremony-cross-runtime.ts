import { readFileSync } from "node:fs";
import { dirname } from "node:path";

import { AuthService } from "../../src/identity/auth.js";
import { createTestConfig } from "../../src/platform/config.js";
import { SuplexDatabase } from "../../src/platform/database.js";

const [mode, filename, token, challengeId] = process.argv.slice(2);
if (!filename || !challengeId || (mode !== "register" && mode !== "authenticate")) {
  throw new Error("Expected mode, database path, optional token, and challenge ID");
}
const fixture = JSON.parse(readFileSync(new URL("../fixtures/webauthn-interop.json", import.meta.url), "utf8")) as {
  origin: string;
  registration: unknown;
  assertion: unknown;
};
const database = new SuplexDatabase(filename, { migrate: false });
const auth = new AuthService(database, createTestConfig(dirname(filename), {
  databasePath: filename,
  reachableAddress: fixture.origin,
}));

try {
  const result = mode === "register"
    ? await auth.completeInvitationRegistration({ token: token ?? "", challengeId, response: fixture.registration })
    : await auth.completeAuthentication({ challengeId, response: fixture.assertion });
  const session = await auth.getUserBySession(result.sessionToken);
  process.stdout.write(JSON.stringify({ userId: result.user.id, sessionUserId: session?.id }));
} finally {
  database.close();
}
