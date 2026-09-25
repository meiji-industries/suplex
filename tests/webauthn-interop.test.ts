import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { X509Certificate } from 'node:crypto';
import { expect, test, vi } from 'vitest';
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
  packedEs256: RegistrationResponseJSON;
  packedPs256: RegistrationResponseJSON;
  packedRs256Rs384: RegistrationResponseJSON;
  packedFullRs256: RegistrationResponseJSON;
  invalidPackedSignature: RegistrationResponseJSON;
  invalidPackedPadding: RegistrationResponseJSON;
  invalidPackedFullSubject: RegistrationResponseJSON;
  invalidPackedFullSignature: RegistrationResponseJSON;
  u2fRegistration: RegistrationResponseJSON;
  u2fExtraCertificate: RegistrationResponseJSON;
  invalidU2fAaguid: RegistrationResponseJSON;
  invalidU2fSignature: RegistrationResponseJSON;
};
const upstreamTpm = JSON.parse(readFileSync(new URL('./fixtures/webauthn-tpm-upstream.json', import.meta.url), 'utf8')) as RegistrationResponseJSON;
const upstreamApple = JSON.parse(readFileSync(new URL('./fixtures/webauthn-apple-upstream.json', import.meta.url), 'utf8')) as RegistrationResponseJSON;
const upstreamAndroidKey = JSON.parse(readFileSync(new URL('./fixtures/webauthn-android-key-upstream.json', import.meta.url), 'utf8')) as RegistrationResponseJSON;
const syntheticSafetyNet = JSON.parse(readFileSync(new URL('./fixtures/webauthn-safetynet-synthetic.json', import.meta.url), 'utf8')) as {
  timestampMs: number;
  rootPEM: string;
  rpId: string;
  origin: string;
  challenge: string;
  registration: RegistrationResponseJSON;
  falseCtsRegistration: RegistrationResponseJSON;
  paddedRegistration: RegistrationResponseJSON;
};
const requireFromServer = createRequire(import.meta.resolve('@simplewebauthn/server'));
const { decodeCBOR, encodeCBOR } = requireFromServer('@levischuck/tiny-cbor') as {
  decodeCBOR: (bytes: Uint8Array) => Map<string, unknown>;
  encodeCBOR: (value: Map<string, unknown>) => Uint8Array;
};

test('SimpleWebAuthn accepts the signed upstream TPM response and rejects changed evidence', async () => {
  const input = {
    response: upstreamTpm,
    expectedChallenge: 'E2YebMmG9992XialpFL1lkPptOIBPeKsphNkt1JcbKk',
    expectedOrigin: 'https://webauthn.firstyear.id.au',
    expectedRPID: 'webauthn.firstyear.id.au',
    requireUserVerification: true,
  };
  expect((await verifyRegistrationResponse(input)).verified).toBe(true);
  await expect(verifyRegistrationResponse({ ...input, expectedChallenge: 'wrong' })).rejects.toThrow();
  await expect(verifyRegistrationResponse({ ...input, expectedOrigin: 'https://wrong.example' })).rejects.toThrow();
  await expect(verifyRegistrationResponse({ ...input, expectedRPID: 'wrong.example' })).rejects.toThrow();
  for (const field of ['sig', 'pubArea', 'certInfo']) {
    const response = structuredClone(upstreamTpm);
    const object = decodeCBOR(Uint8Array.from(Buffer.from(response.response.attestationObject, 'base64url')));
    const statement = object.get('attStmt') as Map<string, Uint8Array>;
    const changed = Uint8Array.from(statement.get(field)!);
    changed[Math.floor(changed.length / 2)]! ^= 1;
    statement.set(field, changed);
    response.response.attestationObject = Buffer.from(encodeCBOR(object)).toString('base64url');
    let verified = false;
    try {
      verified = (await verifyRegistrationResponse({ ...input, response })).verified;
    } catch {
      verified = false;
    }
    expect(verified, field).toBe(false);
  }
});

test('SimpleWebAuthn checks the historical Apple attestation certificate window', async () => {
  const input = {
    response: upstreamApple,
    expectedChallenge: 'JTbk7yekIKOZQwwdGW7NeDIfxrYK0PvuYxsue--G9NI',
    expectedOrigin: 'https://spectral.local:8443',
    expectedRPID: 'spectral.local',
    requireUserVerification: true,
  };
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2020-12-09T00:00:00Z'));
    expect((await verifyRegistrationResponse(input)).verified).toBe(true);
    vi.setSystemTime(new Date('2026-09-24T00:00:00Z'));
    await expect(verifyRegistrationResponse(input)).rejects.toThrow();
  } finally {
    vi.useRealTimers();
  }
});

test('SimpleWebAuthn requires the SafetyNet root and CTS policy for a signed statement', async () => {
  const { SettingsService } = await import(new URL('./services/settingsService.js', import.meta.resolve('@simplewebauthn/server')).href);
  const originalRoots = SettingsService.getRootCertificates({ identifier: 'android-safetynet' });
  const input = {
    expectedChallenge: syntheticSafetyNet.challenge,
    expectedOrigin: syntheticSafetyNet.origin,
    expectedRPID: syntheticSafetyNet.rpId,
    requireUserVerification: true,
  };
  vi.useFakeTimers();
  try {
    vi.setSystemTime(syntheticSafetyNet.timestampMs + 1000);
    await expect(verifyRegistrationResponse({ ...input, response: syntheticSafetyNet.registration })).rejects.toThrow();
    SettingsService.setRootCertificates({ identifier: 'android-safetynet', certificates: [syntheticSafetyNet.rootPEM] });
    expect((await verifyRegistrationResponse({ ...input, response: syntheticSafetyNet.registration })).verified).toBe(true);
    expect((await verifyRegistrationResponse({ ...input, response: syntheticSafetyNet.paddedRegistration })).verified).toBe(true);
    await expect(verifyRegistrationResponse({ ...input, response: syntheticSafetyNet.falseCtsRegistration })).rejects.toThrow();
    const changedStatement = (field: string, value: unknown) => {
      const response = structuredClone(syntheticSafetyNet.registration);
      const object = decodeCBOR(Uint8Array.from(Buffer.from(response.response.attestationObject, 'base64url')));
      const statement = object.get('attStmt') as Map<string, unknown>;
      statement.set(field, value);
      response.response.attestationObject = Buffer.from(encodeCBOR(object)).toString('base64url');
      return response;
    };
    expect((await verifyRegistrationResponse({ ...input, response: changedStatement('ver', 1) })).verified).toBe(true);
    await expect(verifyRegistrationResponse({ ...input, response: changedStatement('alg', 'invalid') })).rejects.toThrow();
  } finally {
    SettingsService.setRootCertificates({ identifier: 'android-safetynet', certificates: originalRoots });
    vi.useRealTimers();
  }
});

test('SimpleWebAuthn accepts archived Android Key only under its test root', async () => {
  const { SettingsService } = await import(new URL('./services/settingsService.js', import.meta.resolve('@simplewebauthn/server')).href);
  const originalRoots = SettingsService.getRootCertificates({ identifier: 'android-key' });
  const input = {
    response: upstreamAndroidKey,
    expectedChallenge: 'Tf65bS6D5temh2BwvptqgBPb25iZDRxjwC5ans91IIJDrcrOpnWTK4LVgFjeUV4GDMe44w8SI5NsZssIXTUvDg',
    expectedOrigin: 'https://webauthn.org',
    expectedRPID: 'webauthn.org',
    requireUserVerification: true,
  };
  const object = decodeCBOR(Uint8Array.from(Buffer.from(upstreamAndroidKey.response.attestationObject, 'base64url')));
  const statement = object.get('attStmt') as Map<string, Uint8Array[]>;
  const certificates = statement.get('x5c')!;
  const root = new X509Certificate(Buffer.from(certificates.at(-1)!)).toString();
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    await expect(verifyRegistrationResponse(input)).rejects.toThrow();
    SettingsService.setRootCertificates({ identifier: 'android-key', certificates: [root] });
    const verified = await verifyRegistrationResponse(input);
    expect(verified.verified).toBe(true);
    if (verified.verified) expect(verified.registrationInfo.credential.id).toBe('AVUvAmX241vMKYd7ZBdmkNWaYcNYhoSZCJjFRGmROb6I4ygQUVmH6k9IMwcbZGeAQ4v4WMNphORudwje5h7ty9A');
    const badSignature = structuredClone(upstreamAndroidKey);
    const changed = decodeCBOR(Uint8Array.from(Buffer.from(badSignature.response.attestationObject, 'base64url')));
    const statement = changed.get('attStmt') as Map<string, Uint8Array>;
    const signature = Uint8Array.from(statement.get('sig')!);
    signature[Math.floor(signature.length / 2)]! ^= 1;
    statement.set('sig', signature);
    badSignature.response.attestationObject = Buffer.from(encodeCBOR(changed)).toString('base64url');
    let accepted = false;
    try { accepted = (await verifyRegistrationResponse({ ...input, response: badSignature })).verified; } catch { accepted = false; }
    expect(accepted).toBe(false);
  } finally {
    SettingsService.setRootCertificates({ identifier: 'android-key', certificates: originalRoots });
    vi.useRealTimers();
  }
});

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

test('SimpleWebAuthn stores the signed authenticator ID when response id differs', async () => {
  const response = structuredClone(fixture.packedFullRs256);
  response.id = 'YWJj';
  response.rawId = 'YWJj';
  const verified = await verifyRegistrationResponse({
    response,
    expectedChallenge: fixture.registrationChallenge,
    expectedOrigin: fixture.origin,
    expectedRPID: fixture.rpId,
    requireUserVerification: true,
  });
  expect(verified.verified).toBe(true);
  if (verified.verified) expect(verified.registrationInfo.credential.id).toBe('g06So-HmBl8oCMHl5j466FSFEHvjutKcDJL3rhSZttc');
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
  for (const response of [fixture.packedEs256, fixture.packedPs256, fixture.packedRs256Rs384, fixture.packedFullRs256]) {
    expect((await verifyRegistrationResponse({ ...registrationInput, response })).verified).toBe(true);
  }
  expect((await verifyRegistrationResponse({ ...registrationInput, response: fixture.invalidPackedSignature })).verified).toBe(false);
  expect((await verifyRegistrationResponse({ ...registrationInput, response: fixture.invalidPackedPadding })).verified).toBe(false);
  for (const response of [fixture.invalidPackedFullSubject, fixture.invalidPackedFullSignature, fixture.invalidU2fSignature]) {
    let verified = false;
    try {
      verified = (await verifyRegistrationResponse({ ...registrationInput, response })).verified;
    } catch {
      verified = false;
    }
    expect(verified).toBe(false);
  }
  for (const response of [fixture.u2fRegistration, fixture.u2fExtraCertificate]) {
    expect((await verifyRegistrationResponse({ ...registrationInput, response })).verified).toBe(true);
  }
  await expect(verifyRegistrationResponse({ ...registrationInput, response: fixture.invalidU2fAaguid })).rejects.toThrow();
});
