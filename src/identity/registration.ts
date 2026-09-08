import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/server";

import type { ForgeDatabase } from "../platform/database.js";
import { neutralUsername } from "./auth-identifiers.js";
import type { AuthRepository } from "./auth-repository.js";
import {
  AuthFailure,
  idSchema,
  invitationFailure,
  invitationTokenSchema,
  parseResponse,
  passkeyFailure,
  type AuthOptions,
  type AuthResult,
  type AuthUser,
  type InvitationKind,
  type InvitationRow,
} from "./auth-contracts.js";
import type {
  AuthenticatorTransportFuture,
  RegistrationVerification,
  WebAuthnAdapter,
} from "./auth-webauthn.js";

export interface RegistrationDependencies {
  database: Pick<ForgeDatabase, "authTransaction">;
  repository: AuthRepository;
  webAuthn: WebAuthnAdapter;
  rpId: string;
  origin: string;
  now: () => Date;
  createId: (prefix: string) => string;
  hashSecret: (secret: string) => string;
  findValidInvitation: (
    tokenHash: string,
    kind: InvitationKind,
  ) => InvitationRow | undefined;
  validInvitation: (rawToken: string, kind: InvitationKind) => InvitationRow;
  parseTransports: (
    value: string,
  ) => AuthenticatorTransportFuture[] | undefined;
  safeJson: (value: unknown) => string;
  recordAuditEvent: (
    action: string,
    userId: string,
    metadata: Record<string, string>,
  ) => void;
  publicUser: (user: {
    id: string;
    displayName: string;
    username: string;
    avatarSeed?: string;
    role: "admin" | "member";
    status: "pending" | "active" | "revoked";
  }) => AuthUser;
  createSession: (userId: string) => string;
  safeMetadata: (value: string) => Record<string, string>;
}

export async function beginRegistration(
  dependencies: RegistrationDependencies,
  kind: "bootstrap" | "user" | "recovery",
  rawToken: string,
): Promise<AuthOptions<PublicKeyCredentialCreationOptionsJSON>> {
  const invitation = dependencies.validInvitation(rawToken, kind);
  const userId = invitation.user_id ?? dependencies.createId("pending");
  const username = neutralUsername(userId);
  const existingCredentials = invitation.user_id
    ? dependencies.repository.credentialsForUser(invitation.user_id)
    : [];
  let options: PublicKeyCredentialCreationOptionsJSON;
  try {
    options = await dependencies.webAuthn.generateRegistrationOptions({
      userId: Buffer.from(userId).toString("base64url"),
      userName: username,
      displayName: invitation.display_name,
      rpId: dependencies.rpId,
      excludeCredentials: existingCredentials.map((credential) => {
        const transports = dependencies.parseTransports(credential.transports);
        return {
          id: credential.credentialId,
          ...(transports ? { transports } : {}),
        };
      }),
    });
  } catch {
    throw passkeyFailure();
  }
  const challengeId = dependencies.createId("challenge");
  const expiresAt = new Date(
    dependencies.now().getTime() + 5 * 60 * 1000,
  ).toISOString();
  dependencies.database.authTransaction(() => {
    const current = dependencies.findValidInvitation(
      dependencies.hashSecret(rawToken),
      kind,
    );
    if (!current) {
      throw invitationFailure();
    }
    dependencies.repository.createChallenge({
      id: challengeId,
      challenge: options.challenge,
      kind: `registration:${kind}`,
      invitationId: current.id,
      userId: current.user_id,
      expiresAt,
      consumedAt: null,
      createdAt: dependencies.now().toISOString(),
    });
  });
  return { challengeId, options };
}

export async function completeRegistration(
  dependencies: RegistrationDependencies,
  kind: "bootstrap" | "user" | "recovery",
  input: { token: string; challengeId: string; response: unknown },
): Promise<AuthResult> {
  const parsedToken = invitationTokenSchema.safeParse(input.token);
  const parsedChallenge = idSchema.safeParse(input.challengeId);
  if (!parsedToken.success || !parsedChallenge.success) {
    throw invitationFailure();
  }
  const response = parseResponse(input.response);
  const tokenHash = dependencies.hashSecret(input.token);
  const ceremony = dependencies.database.authTransaction(() => {
    const invitation = dependencies.findValidInvitation(tokenHash, kind);
    const challenge = dependencies.repository.findChallenge(
      input.challengeId,
      `registration:${kind}`,
    );
    if (
      !invitation ||
      !challenge ||
      challenge.invitationId !== invitation.id ||
      challenge.consumedAt ||
      Date.parse(challenge.expiresAt) <= dependencies.now().getTime()
    ) {
      throw invitationFailure();
    }
    if (
      !dependencies.repository.consumeChallenge(
        challenge.id,
        dependencies.now().toISOString(),
      )
    )
      throw invitationFailure();
    return { invitation, challenge };
  });
  let verification: RegistrationVerification;
  try {
    verification = await dependencies.webAuthn.verifyRegistrationResponse({
      response,
      expectedChallenge: ceremony.challenge.challenge,
      expectedOrigin: dependencies.origin,
      expectedRpId: dependencies.rpId,
    });
  } catch {
    throw passkeyFailure();
  }
  if (!verification.verified) {
    throw passkeyFailure();
  }
  return dependencies.database.authTransaction(() => {
    const invitation = dependencies.findValidInvitation(tokenHash, kind);
    if (!invitation) {
      throw invitationFailure();
    }
    let userId: string;
    const now = dependencies.now().toISOString();
    if (kind === "bootstrap") {
      if (dependencies.repository.hasActiveAdmin()) throw invitationFailure();
      userId = dependencies.createId("user");
      dependencies.repository.createUser({
        id: userId,
        displayName: invitation.display_name,
        username: neutralUsername(userId),
        avatarSeed: neutralUsername(userId),
        role: "admin",
        status: "active",
        createdAt: now,
        updatedAt: now,
        identityVersion: 1,
      });
    } else if (kind === "recovery") {
      const adminIds = dependencies.repository.activeAdminIds();
      for (const adminId of adminIds)
        dependencies.repository.updateUserStatus(adminId, "revoked", now);
      dependencies.repository.revokeCredentialsForUsers(adminIds, now);
      dependencies.repository.revokeSessionsForUsers(adminIds, now);
      userId = dependencies.createId("user");
      dependencies.repository.createUser({
        id: userId,
        displayName: invitation.display_name,
        username: neutralUsername(userId),
        avatarSeed: neutralUsername(userId),
        role: "admin",
        status: "active",
        createdAt: now,
        updatedAt: now,
        identityVersion: 1,
      });
    } else {
      if (!invitation.user_id) {
        throw invitationFailure();
      }
      const pending = dependencies.repository.findUser(
        invitation.user_id,
        "pending",
      );
      if (!pending) {
        throw invitationFailure();
      }
      userId = pending.id;
      dependencies.repository.updateUserStatus(userId, "active", now);
    }
    try {
      dependencies.repository.createCredential({
        id: dependencies.createId("credential"),
        userId,
        credentialId: verification.credential.id,
        publicKey: Buffer.from(verification.credential.publicKey),
        counter: verification.credential.counter,
        transports: dependencies.safeJson(
          verification.credential.transports ?? [],
        ),
        createdAt: now,
        revokedAt: null,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        /UNIQUE constraint failed: forge_credentials\.credential_id/i.test(
          error.message,
        )
      ) {
        throw new AuthFailure(
          "Credential is already registered",
          409,
          "credential_duplicate",
        );
      }
      throw passkeyFailure();
    }
    if (!dependencies.repository.consumeInvitation(invitation.id, now))
      throw invitationFailure();
    dependencies.recordAuditEvent(
      kind === "recovery" ? "recovery_completed" : "user_enrolled",
      userId,
      kind === "recovery"
        ? {
            ...dependencies.safeMetadata(invitation.metadata_json),
            invitationId: invitation.id,
          }
        : {},
    );
    const user = dependencies.repository.findUser(userId, "active");
    if (!user) throw passkeyFailure();
    return {
      user: dependencies.publicUser(user),
      sessionToken: dependencies.createSession(userId),
    };
  });
}
