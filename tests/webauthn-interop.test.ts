import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { verifyAuthenticationResponse, verifyRegistrationResponse, type AuthenticationResponseJSON, type RegistrationResponseJSON } from '@simplewebauthn/server';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/webauthn-interop.json', import.meta.url), 'utf8')) as {
  rpId: string;
  origin: string;
  userId: string;
  registrationChallenge: string;
  authenticationChallenge: string;
  credentialId: string;
  publicKey: string;
  registration: RegistrationResponseJSON;
  backedUpRegistration: RegistrationResponseJSON;
  noUvRegistration: RegistrationResponseJSON;
  badAttestationStatement: RegistrationResponseJSON;
  assertion: AuthenticationResponseJSON;
  zeroCounterAssertion: AuthenticationResponseJSON;
  backedUpAssertion: AuthenticationResponseJSON;
  eddsa: { credentialId: string; publicKey: string; registration: RegistrationResponseJSON; assertion: AuthenticationResponseJSON };
  es512: { credentialId: string; publicKey: string; registration: RegistrationResponseJSON; assertion: AuthenticationResponseJSON };
  rs256: { credentialId: string; publicKey: string; registration: RegistrationResponseJSON; assertion: AuthenticationResponseJSON };
  ps256: { credentialId: string; publicKey: string; registration: RegistrationResponseJSON; assertion: AuthenticationResponseJSON };
  ps384: { credentialId: string; publicKey: string; registration: RegistrationResponseJSON; assertion: AuthenticationResponseJSON };
  ps512: { credentialId: string; publicKey: string; registration: RegistrationResponseJSON; assertion: AuthenticationResponseJSON };
  rs384: { credentialId: string; publicKey: string; registration: RegistrationResponseJSON; assertion: AuthenticationResponseJSON };
  rs512: { credentialId: string; publicKey: string; registration: RegistrationResponseJSON; assertion: AuthenticationResponseJSON };
  rs1: { credentialId: string; publicKey: string; registration: RegistrationResponseJSON; assertion: AuthenticationResponseJSON };
  invalidTokenBindingRegistration: RegistrationResponseJSON;
  invalidTokenBindingAssertion: AuthenticationResponseJSON;
  crossOriginAssertion: AuthenticationResponseJSON;
};

test('SimpleWebAuthn accepts the shared synthetic credential and both counter modes', async () => {
  const registered = await verifyRegistrationResponse({ response: fixture.registration, expectedChallenge: fixture.registrationChallenge, expectedOrigin: fixture.origin, expectedRPID: fixture.rpId, requireUserVerification: true });
  expect(registered.verified).toBe(true);
  if (!registered.verified) return;
  expect(registered.registrationInfo.credential.id).toBe(fixture.credentialId);
  expect(Buffer.from(registered.registrationInfo.credential.publicKey).toString('base64url')).toBe(fixture.publicKey);
  expect(registered.registrationInfo.credential.counter).toBe(0);
  expect(Buffer.from(fixture.assertion.response.userHandle!, 'base64url').toString()).toBe(fixture.userId);
  const verify = (response: AuthenticationResponseJSON, counter = 0) => verifyAuthenticationResponse({
    response, expectedChallenge: fixture.authenticationChallenge, expectedOrigin: fixture.origin,
    expectedRPID: fixture.rpId, credential: { ...registered.registrationInfo.credential, counter }, requireUserVerification: true,
  });
  expect((await verify(fixture.assertion)).authenticationInfo.newCounter).toBe(1);
  expect((await verify(fixture.zeroCounterAssertion)).authenticationInfo.newCounter).toBe(0);
  const backedUpRegistered = await verifyRegistrationResponse({ response: fixture.backedUpRegistration, expectedChallenge: fixture.registrationChallenge, expectedOrigin: fixture.origin, expectedRPID: fixture.rpId, requireUserVerification: true });
  expect(backedUpRegistered.verified).toBe(true);
  if (!backedUpRegistered.verified) return;
  expect(backedUpRegistered.registrationInfo.credentialBackedUp).toBe(true);
  expect((await verifyAuthenticationResponse({ response: fixture.backedUpAssertion, expectedChallenge: fixture.authenticationChallenge, expectedOrigin: fixture.origin, expectedRPID: fixture.rpId, credential: backedUpRegistered.registrationInfo.credential, requireUserVerification: true })).authenticationInfo.newCounter).toBe(0);
  const eddsaRegistered = await verifyRegistrationResponse({ response: fixture.eddsa.registration, expectedChallenge: fixture.registrationChallenge, expectedOrigin: fixture.origin, expectedRPID: fixture.rpId, requireUserVerification: true });
  expect(eddsaRegistered.verified).toBe(true);
  if (!eddsaRegistered.verified) return;
  expect(eddsaRegistered.registrationInfo.credential.id).toBe(fixture.eddsa.credentialId);
  expect(Buffer.from(eddsaRegistered.registrationInfo.credential.publicKey).toString('base64url')).toBe(fixture.eddsa.publicKey);
  expect((await verifyAuthenticationResponse({ response: fixture.eddsa.assertion, expectedChallenge: fixture.authenticationChallenge, expectedOrigin: fixture.origin, expectedRPID: fixture.rpId, credential: eddsaRegistered.registrationInfo.credential, requireUserVerification: true })).verified).toBe(true);
  const es512Registered = await verifyRegistrationResponse({ response: fixture.es512.registration, expectedChallenge: fixture.registrationChallenge, expectedOrigin: fixture.origin, expectedRPID: fixture.rpId, requireUserVerification: true });
  expect(es512Registered.verified).toBe(true);
  if (!es512Registered.verified) return;
  expect(Buffer.from(es512Registered.registrationInfo.credential.publicKey).toString('base64url')).toBe(fixture.es512.publicKey);
  expect((await verifyAuthenticationResponse({ response: fixture.es512.assertion, expectedChallenge: fixture.authenticationChallenge, expectedOrigin: fixture.origin, expectedRPID: fixture.rpId, credential: es512Registered.registrationInfo.credential, requireUserVerification: true })).verified).toBe(true);
  for (const algorithm of ['rs256', 'ps256', 'ps384', 'ps512', 'rs384', 'rs512', 'rs1'] as const) {
    const vector = fixture[algorithm];
    const registered = await verifyRegistrationResponse({ response: vector.registration, expectedChallenge: fixture.registrationChallenge, expectedOrigin: fixture.origin, expectedRPID: fixture.rpId, requireUserVerification: true });
    expect(registered.verified).toBe(true);
    if (!registered.verified) continue;
    expect(registered.registrationInfo.credential.id).toBe(vector.credentialId);
    expect(Buffer.from(registered.registrationInfo.credential.publicKey).toString('base64url')).toBe(vector.publicKey);
    expect((await verifyAuthenticationResponse({ response: vector.assertion, expectedChallenge: fixture.authenticationChallenge, expectedOrigin: fixture.origin, expectedRPID: fixture.rpId, credential: registered.registrationInfo.credential, requireUserVerification: true })).verified).toBe(true);
  }
  await expect(verify(fixture.assertion, 1)).rejects.toThrow();
});

test('SimpleWebAuthn rejects changed ceremony identity, UV, and signature', async () => {
  const credential = { id: fixture.credentialId, publicKey: Buffer.from(fixture.publicKey, 'base64url'), counter: 0, transports: ['internal' as const] };
  const input = { response: fixture.assertion, expectedChallenge: fixture.authenticationChallenge, expectedOrigin: fixture.origin, expectedRPID: fixture.rpId, credential, requireUserVerification: true };
  await expect(verifyAuthenticationResponse({ ...input, expectedChallenge: 'wrong' })).rejects.toThrow();
  await expect(verifyAuthenticationResponse({ ...input, expectedOrigin: 'https://wrong.example.test' })).rejects.toThrow();
  await expect(verifyAuthenticationResponse({ ...input, expectedRPID: 'wrong.example.test' })).rejects.toThrow();
  const noUv = structuredClone(fixture.assertion);
  const authData = Buffer.from(noUv.response.authenticatorData, 'base64url');
  authData[32] = authData[32]! & ~0x04;
  noUv.response.authenticatorData = authData.toString('base64url');
  await expect(verifyAuthenticationResponse({ ...input, response: noUv })).rejects.toThrow();
  const badSignature = structuredClone(fixture.assertion);
  badSignature.response.signature = Buffer.alloc(64).toString('base64url');
  await expect(verifyAuthenticationResponse({ ...input, response: badSignature })).rejects.toThrow();
  const registrationInput = { response: fixture.registration, expectedChallenge: fixture.registrationChallenge, expectedOrigin: fixture.origin, expectedRPID: fixture.rpId, requireUserVerification: true };
  await expect(verifyRegistrationResponse({ ...registrationInput, expectedChallenge: 'wrong' })).rejects.toThrow();
  await expect(verifyRegistrationResponse({ ...registrationInput, expectedOrigin: 'https://wrong.example.test' })).rejects.toThrow();
  await expect(verifyRegistrationResponse({ ...registrationInput, expectedRPID: 'wrong.example.test' })).rejects.toThrow();
  await expect(verifyRegistrationResponse({ ...registrationInput, response: fixture.noUvRegistration })).rejects.toThrow();
  await expect(verifyRegistrationResponse({ ...registrationInput, response: fixture.badAttestationStatement })).rejects.toThrow();
  await expect(verifyRegistrationResponse({ ...registrationInput, response: fixture.invalidTokenBindingRegistration })).rejects.toThrow();
  const ps256Credential = { id: fixture.ps256.credentialId, publicKey: Buffer.from(fixture.ps256.publicKey, 'base64url'), counter: 0 };
  await expect(verifyAuthenticationResponse({ ...input, response: fixture.invalidTokenBindingAssertion, credential: ps256Credential })).rejects.toThrow();
  expect((await verifyAuthenticationResponse({ ...input, response: fixture.crossOriginAssertion, credential: ps256Credential })).verified).toBe(true);
});
