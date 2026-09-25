import { createHash, createSign } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyRegistrationResponse } from '@simplewebauthn/server';

const requireFromServer = createRequire(import.meta.resolve('@simplewebauthn/server'));
const { decodeCBOR, encodeCBOR } = requireFromServer('@levischuck/tiny-cbor');
const { SettingsService } = await import(new URL('./services/settingsService.js', import.meta.resolve('@simplewebauthn/server')));
const base = JSON.parse(readFileSync(new URL('./webauthn-interop.json', import.meta.url), 'utf8'));
const hash = (value) => createHash('sha256').update(value).digest();
const directory = mkdtempSync(join(tmpdir(), 'suplex-safetynet-'));
const run = (...args) => {
  const result = spawnSync('openssl', args, { cwd: directory, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`OpenSSL fixture generation failed: ${result.stderr}`);
};

try {
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'root.key', '-out', 'root.pem', '-days', '3650', '-subj', '/CN=Suplex SafetyNet Test Root', '-addext', 'basicConstraints=critical,CA:TRUE');
  run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=attest.android.com');
  writeFileSync(join(directory, 'leaf.cnf'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature\n');
  run('x509', '-req', '-in', 'leaf.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '3650', '-extfile', 'leaf.cnf');
  run('x509', '-in', 'leaf.pem', '-outform', 'DER', '-out', 'leaf.der');
  writeFileSync(join(directory, 'index.txt'), '');
  writeFileSync(join(directory, 'serial'), '1000\n');
  writeFileSync(join(directory, 'crlnumber'), '1000\n');
  writeFileSync(join(directory, 'ca.cnf'), `[ca]\ndefault_ca=CA_default\n[CA_default]\nnew_certs_dir=${directory}\ndatabase=${join(directory, 'index.txt')}\nserial=${join(directory, 'serial')}\ncrlnumber=${join(directory, 'crlnumber')}\ncertificate=${join(directory, 'root.pem')}\nprivate_key=${join(directory, 'root.key')}\ndefault_md=sha256\ndefault_crl_days=1\npolicy=policy_any\n[policy_any]\ncommonName=supplied\n`);
  run('ca', '-config', 'ca.cnf', '-revoke', 'leaf.pem', '-batch');
  run('ca', '-config', 'ca.cnf', '-gencrl', '-out', 'revoked.crl.pem', '-batch');
  run('crl', '-in', 'revoked.crl.pem', '-outform', 'DER', '-out', 'revoked.crl.der');

  const rootPEM = readFileSync(join(directory, 'root.pem'), 'utf8');
  const leafDER = readFileSync(join(directory, 'leaf.der'));
  const leafKey = readFileSync(join(directory, 'leaf.key'));
  const original = decodeCBOR(Uint8Array.from(Buffer.from(base.registration.response.attestationObject, 'base64url')));
  const authData = Buffer.from(original.get('authData'));
  const clientData = Buffer.from(base.registration.response.clientDataJSON, 'base64url');
  const timestampMs = Date.now();
  const encoded = (bytes, padded) => {
    const value = Buffer.from(bytes).toString('base64url');
    return padded ? value.padEnd(Math.ceil(value.length / 4) * 4, '=') : value;
  };
  const nonce = hash(Buffer.concat([authData, hash(clientData)])).toString('base64');
  const makeResponse = (ctsProfileMatch, padded = false) => {
    const header = encoded(JSON.stringify({ alg: 'RS256', x5c: [leafDER.toString('base64')] }), padded);
    const payload = encoded(JSON.stringify({ nonce, timestampMs, ctsProfileMatch }), padded);
    const signed = `${header}.${payload}`;
    const signature = encoded(createSign('sha256').update(signed).sign(leafKey), padded);
    const jwt = Buffer.from(`${signed}.${signature}`);
    const attestationObject = Buffer.from(encodeCBOR(new Map([
      ['fmt', 'android-safetynet'], ['authData', authData],
      ['attStmt', new Map([['ver', 'synthetic'], ['response', jwt]])],
    ]))).toString('base64url');
    return { ...base.registration, response: { ...base.registration.response, attestationObject } };
  };
  const registration = makeResponse(true);
  const falseCtsRegistration = makeResponse(false);
  const paddedRegistration = makeResponse(true, true);
  SettingsService.setRootCertificates({ identifier: 'android-safetynet', certificates: [rootPEM] });
  const input = { expectedChallenge: base.registrationChallenge, expectedOrigin: base.origin, expectedRPID: base.rpId, requireUserVerification: true };
  if (!(await verifyRegistrationResponse({ response: registration, ...input })).verified) throw new Error('SimpleWebAuthn synthetic SafetyNet registration failed');
  if (!(await verifyRegistrationResponse({ response: paddedRegistration, ...input })).verified) throw new Error('SimpleWebAuthn padded SafetyNet registration failed');
  let rejected = false;
  try { rejected = !(await verifyRegistrationResponse({ response: falseCtsRegistration, ...input })).verified; } catch { rejected = true; }
  if (!rejected) throw new Error('SimpleWebAuthn accepted synthetic false CTS');
  const revokedCRL = readFileSync(join(directory, 'revoked.crl.der')).toString('base64');
  const fixture = { timestampMs, rootPEM, revokedCRL, rpId: base.rpId, origin: base.origin, challenge: base.registrationChallenge, registration, falseCtsRegistration, paddedRegistration };
  writeFileSync(new URL('./webauthn-safetynet-synthetic.json', import.meta.url), `${JSON.stringify(fixture, null, 2)}\n`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
