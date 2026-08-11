import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { expect, test } from "vitest";

import { AuthService, productionWebAuthnAdapter, type WebAuthnAdapter } from "../src/auth.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";

function fakeWebAuthn(): WebAuthnAdapter {
  let challengeNumber = 0;
  return {
    async generateRegistrationOptions(input) {
      challengeNumber += 1;
      return {
        rp: { name: "Forge", id: input.rpId },
        user: { id: input.userId, name: input.userName, displayName: input.displayName },
        challenge: Buffer.from(`registration-${challengeNumber}`).toString("base64url"),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        attestation: "none",
      };
    },
    async verifyRegistrationResponse(input) {
      return {
        verified: true,
        credential: { id: input.response.id, publicKey: Uint8Array.from([1, 2, 3]), counter: 0, transports: ["internal"] },
      };
    },
    async generateAuthenticationOptions(input) {
      challengeNumber += 1;
      return { challenge: Buffer.from(`authentication-${challengeNumber}`).toString("base64url"), rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" };
    },
    async verifyAuthenticationResponse() {
      return { verified: true, newCounter: 1 };
    },
  };
}

async function fixture(): Promise<{ root: string; filename: string; database: ForgeDatabase; auth: AuthService }> {
  const root = await mkdtemp(join(tmpdir(), "forge-auth-test-"));
  const filename = join(root, "forge.sqlite");
  const database = new ForgeDatabase(filename);
  const auth = new AuthService(database, createTestConfig(root, { reachableAddress: "https://forge.tailnet.ts.net:4111" }), { webAuthn: fakeWebAuthn() });
  return { root, filename, database, auth };
}

async function closeFixture(fixtureValue: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  fixtureValue.database.close();
  await rm(fixtureValue.root, { recursive: true, force: true });
}

async function enrollBootstrap(auth: AuthService, token: string, credentialId = "admin-credential") {
  const options = await auth.beginBootstrapRegistration(token);
  return auth.completeBootstrapRegistration({ token, challengeId: options.challengeId, response: { id: credentialId, type: "public-key" } });
}

async function enrollUser(auth: AuthService, token: string, credentialId: string) {
  const options = await auth.beginInvitationRegistration(token);
  return auth.completeInvitationRegistration({ token, challengeId: options.challengeId, response: { id: credentialId, type: "public-key" } });
}

test("bootstrap invitations are hashed, replaceable, single-use, and expire without leakage", async () => {
  const value = await fixture();
  let now = new Date("2026-08-11T00:00:00.000Z");
  value.database.close();
  const database = new ForgeDatabase(value.filename);
  const auth = new AuthService(database, createTestConfig(value.root, { reachableAddress: "https://forge.tailnet.ts.net:4111" }), { webAuthn: fakeWebAuthn(), now: () => now });
  try {
    const first = auth.ensureBootstrapInvitation();
    expect(first).toBeDefined();
    const second = auth.ensureBootstrapInvitation();
    expect(second).toBeDefined();
    await expect(auth.beginBootstrapRegistration(first!.token)).rejects.toMatchObject({ publicMessage: "Invitation is invalid or expired" });

    const raw = new Database(value.filename);
    const invitations = raw.prepare("SELECT token_hash, consumed_at, replaced_at FROM forge_invitations ORDER BY created_at").all() as Array<{ token_hash: string; consumed_at: string | null; replaced_at: string | null }>;
    expect(invitations).toHaveLength(2);
    expect(JSON.stringify(invitations)).not.toContain(second!.token);
    expect(invitations[0]?.replaced_at).toBeTruthy();
    raw.close();

    const enrollment = await enrollBootstrap(auth, second!.token);
    expect(enrollment.user.role).toBe("admin");
    await expect(enrollBootstrap(auth, second!.token, "replayed")).rejects.toMatchObject({ publicMessage: "Invitation is invalid or expired" });

    const malformed = "forge_bootstrap_not-a-token";
    await expect(auth.beginBootstrapRegistration(malformed)).rejects.toMatchObject({ publicMessage: "Invitation is invalid or expired" });

    now = new Date("2026-08-11T00:00:00.000Z");
    const expiredFixture = await fixture();
    const expiredAuth = new AuthService(expiredFixture.database, createTestConfig(expiredFixture.root), { webAuthn: fakeWebAuthn(), now: () => now, invitationTtlMs: 1 });
    const expired = expiredAuth.ensureBootstrapInvitation()!;
    now = new Date("2026-08-11T00:00:00.002Z");
    await expect(expiredAuth.beginBootstrapRegistration(expired.token)).rejects.toMatchObject({ publicMessage: "Invitation is invalid or expired" });
    await closeFixture(expiredFixture);
  } finally {
    database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("passkey authentication creates a hashed session and sign-out revokes it", async () => {
  const value = await fixture();
  try {
    const invitation = value.auth.ensureBootstrapInvitation()!;
    const enrollment = await enrollBootstrap(value.auth, invitation.token);
    const options = await value.auth.beginAuthentication();
    const signedIn = await value.auth.completeAuthentication({ challengeId: options.challengeId, response: { id: "admin-credential", type: "public-key" } });
    expect(signedIn.user.id).toBe(enrollment.user.id);
    expect(await value.auth.getUserBySession(signedIn.sessionToken)).toMatchObject({ id: enrollment.user.id, role: "admin" });
    const raw = new Database(value.filename);
    const sessions = raw.prepare("SELECT token_hash FROM forge_sessions").all() as Array<{ token_hash: string }>;
    expect(JSON.stringify(sessions)).not.toContain(signedIn.sessionToken);
    raw.close();
    value.auth.signOut(signedIn.sessionToken);
    expect(await value.auth.getUserBySession(signedIn.sessionToken)).toBeUndefined();
  } finally {
    await closeFixture(value);
  }
});

test("the production WebAuthn adapter rejects an incomplete ceremony instead of accepting it", async () => {
  const value = await fixture();
  const productionAuth = new AuthService(value.database, createTestConfig(value.root, { reachableAddress: "https://forge.tailnet.ts.net:4111" }), { webAuthn: productionWebAuthnAdapter });
  try {
    const invitation = productionAuth.ensureBootstrapInvitation()!;
    const options = await productionAuth.beginBootstrapRegistration(invitation.token);
    await expect(productionAuth.completeBootstrapRegistration({ token: invitation.token, challengeId: options.challengeId, response: { id: "not-a-real-credential", type: "public-key" } })).rejects.toMatchObject({ publicMessage: "Passkey could not be verified" });
    expect(productionAuth.getBootstrapState()).toEqual({ required: true });
  } finally {
    await closeFixture(value);
  }
});

test("non-local HTTP exposure cannot start passkey authentication", async () => {
  const value = await fixture();
  try {
    expect(() => new AuthService(value.database, createTestConfig(value.root, { reachableAddress: "http://forge.tailnet.ts.net:4111" }))).toThrow("requires an HTTPS reachable address");
  } finally {
    await closeFixture(value);
  }
});

test("administrator recovery revokes old administrator access and creates a fresh audited administrator", async () => {
  const value = await fixture();
  try {
    const bootstrap = value.auth.ensureBootstrapInvitation()!;
    const oldAdmin = await enrollBootstrap(value.auth, bootstrap.token);
    const recovery = value.auth.createRecoveryInvitation();
    const recoveryOptions = await value.auth.beginRecoveryRegistration(recovery.token);
    const recovered = await value.auth.completeRecoveryRegistration({ token: recovery.token, challengeId: recoveryOptions.challengeId, response: { id: "recovery-credential", type: "public-key" } });
    expect(recovered.user.role).toBe("admin");
    expect(recovered.user.id).not.toBe(oldAdmin.user.id);
    expect(await value.auth.getUserBySession(oldAdmin.sessionToken)).toBeUndefined();
    const actions = value.auth.listAuditEvents(recovered.user.id).map((event) => event.action);
    expect(actions).toEqual(expect.arrayContaining(["recovery_invitation_created", "recovery_completed"]));
  } finally {
    await closeFixture(value);
  }
});

test("company access is membership-scoped and membership authority is audited", async () => {
  const value = await fixture();
  try {
    const bootstrap = value.auth.ensureBootstrapInvitation()!;
    const admin = await enrollBootstrap(value.auth, bootstrap.token);
    const companyA = value.auth.createCompany(admin.user.id, "Acme");
    const companyB = value.auth.createCompany(admin.user.id, "Other");
    const invitation = value.auth.inviteUser(admin.user.id, { displayName: "Member" });
    const otherInvitation = value.auth.inviteUser(admin.user.id, { displayName: "Other member" });
    const member = await enrollUser(value.auth, invitation.token, "member-credential");
    const otherMember = await enrollUser(value.auth, otherInvitation.token, "other-member-credential");
    expect(otherMember.user.status).toBe("active");

    value.auth.addMembership(admin.user.id, member.user.id, companyA.id);
    expect(value.auth.requireCompanyAccess(member.user.id, companyA.id)).toMatchObject({ id: companyA.id });
    expect(value.auth.listVisibleCompanies(member.user.id).map((company) => company.id)).toEqual([companyA.id]);
    expect(() => value.auth.requireCompanyAccess(member.user.id, companyB.id)).toThrowError("Not found");
    expect(value.auth.requireCompanyAccess(admin.user.id, companyB.id)).toMatchObject({ id: companyB.id });

    value.auth.removeMembership(admin.user.id, member.user.id, companyA.id);
    expect(() => value.auth.requireCompanyAccess(member.user.id, companyA.id)).toThrowError("Not found");
    expect(value.auth.listAuditEvents(admin.user.id).map((event) => event.action)).toEqual(expect.arrayContaining(["membership_added", "membership_removed", "user_invited"]));
  } finally {
    await closeFixture(value);
  }
});

test("revoking a user removes passkey authority and active sessions", async () => {
  const value = await fixture();
  try {
    const bootstrap = value.auth.ensureBootstrapInvitation()!;
    const admin = await enrollBootstrap(value.auth, bootstrap.token);
    const invitation = value.auth.inviteUser(admin.user.id, { displayName: "Revoked" });
    const member = await enrollUser(value.auth, invitation.token, "revoked-credential");
    const options = await value.auth.beginAuthentication();
    const memberSession = await value.auth.completeAuthentication({ challengeId: options.challengeId, response: { id: "revoked-credential", type: "public-key" } });
    value.auth.revokeUser(admin.user.id, member.user.id);
    expect(await value.auth.getUserBySession(memberSession.sessionToken)).toBeUndefined();
    expect(() => value.auth.listUsers(member.user.id)).toThrowError("Authentication required");
  } finally {
    await closeFixture(value);
  }
});
