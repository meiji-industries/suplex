import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";

export type { AuthenticatorTransportFuture } from "@simplewebauthn/server";

export interface WebAuthnAdapter {
  generateRegistrationOptions(input: {
    userId: string;
    userName: string;
    displayName: string;
    rpId: string;
    excludeCredentials: Array<{ id: string; transports?: AuthenticatorTransportFuture[] }>;
  }): Promise<PublicKeyCredentialCreationOptionsJSON>;
  verifyRegistrationResponse(input: {
    response: RegistrationResponseJSON;
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRpId: string;
  }): Promise<RegistrationVerification>;
  generateAuthenticationOptions(input: {
    rpId: string;
    allowCredentials: Array<{ id: string; transports?: AuthenticatorTransportFuture[] }>;
  }): Promise<PublicKeyCredentialRequestOptionsJSON>;
  verifyAuthenticationResponse(input: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRpId: string;
    credential: WebAuthnCredential;
  }): Promise<AuthenticationVerification>;
}

export type RegistrationVerification =
  | { verified: false }
  | {
      verified: true;
      credential: {
        id: string;
        publicKey: Uint8Array;
        counter: number;
        transports?: AuthenticatorTransportFuture[];
      };
    };

export type AuthenticationVerification =
  | { verified: false }
  | { verified: true; newCounter: number };

export const productionWebAuthnAdapter: WebAuthnAdapter = {
  generateRegistrationOptions: async (input) => generateRegistrationOptions({
    rpName: "Forge",
    rpID: input.rpId,
    userID: Buffer.from(input.userId),
    userName: input.userName,
    userDisplayName: input.displayName,
    excludeCredentials: input.excludeCredentials,
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  }),
  verifyRegistrationResponse: async (input) => {
    const result = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.expectedOrigin,
      expectedRPID: input.expectedRpId,
      requireUserVerification: true,
    });
    if (!result.verified) return { verified: false };
    const transports = result.registrationInfo.credential.transports;
    return {
      verified: true,
      credential: {
        id: result.registrationInfo.credential.id,
        publicKey: result.registrationInfo.credential.publicKey,
        counter: result.registrationInfo.credential.counter,
        ...(transports ? { transports } : {}),
      },
    };
  },
  generateAuthenticationOptions: async (input) => generateAuthenticationOptions({
    rpID: input.rpId,
    allowCredentials: input.allowCredentials,
    userVerification: "required",
  }),
  verifyAuthenticationResponse: async (input) => {
    const result = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.expectedOrigin,
      expectedRPID: input.expectedRpId,
      credential: input.credential,
      requireUserVerification: true,
    });
    return result.verified ? { verified: true, newCounter: result.authenticationInfo.newCounter } : { verified: false };
  },
};
