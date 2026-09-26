import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { runCommand } from './helpers/run-command.js';
import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';

const rpId = 'suplex.example.test';
const origin = `https://${rpId}:4111`;
const challenge = () => randomBytes(32).toString('base64url');
async function synthetic(input: object): Promise<{ response: RegistrationResponseJSON & AuthenticationResponseJSON; privateKeyPem: string; credentialId: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'suplex-webauthn-'));
  const output = join(directory, 'response.json');
  try {
    const result = await runCommand({ taskId: null, stepId: null, command: process.execPath,
      args: ['tests/support/webauthn-synthetic.mjs'], cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, SUPLEX_SYNTHETIC_INPUT: JSON.stringify(input), SUPLEX_SYNTHETIC_OUTPUT: output } });
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return JSON.parse(await readFile(output, 'utf8'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('ephemeral none-attestation passkey signs registration and authentication', async () => {
  const registrationChallenge = challenge();
  const registration = await synthetic({ mode: 'register', origin, options: { rp: { id: rpId }, challenge: registrationChallenge } });
  const registered = await verifyRegistrationResponse({
    response: registration.response,
    expectedChallenge: registrationChallenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
    requireUserVerification: true,
  });
  expect(registered.verified).toBe(true);
  if (!registered.verified) return;
  expect(registered.registrationInfo.credential.id).toBe(registration.credentialId);
  const authenticationChallenge = challenge();
  const assertion = await synthetic({
    mode: 'authenticate', origin, options: { rpId, challenge: authenticationChallenge },
    credentialId: registration.credentialId, privateKeyPem: registration.privateKeyPem, counter: 1,
  });
  const authenticated = await verifyAuthenticationResponse({
    response: assertion.response,
    expectedChallenge: authenticationChallenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
    credential: registered.registrationInfo.credential,
    requireUserVerification: true,
  });
  expect(authenticated.verified).toBe(true);
  expect(authenticated.authenticationInfo.newCounter).toBe(1);
});
