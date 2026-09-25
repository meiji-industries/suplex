import { constants, createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';

const requireFromServer = createRequire(import.meta.resolve('@simplewebauthn/server'));
const { encodeCBOR } = requireFromServer('@levischuck/tiny-cbor');
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const hash = (bytes) => createHash('sha256').update(bytes).digest();
const rpId = 'suplex.example.test';
const origin = `https://${rpId}:4111`;
const userId = 'user_existing';
const credentialId = randomBytes(32);
const registrationChallenge = b64(randomBytes(32));
const authenticationChallenge = b64(randomBytes(32));
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = publicKey.export({ format: 'jwk' });
const cose = Buffer.from(encodeCBOR(new Map([
  [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')],
])));
const authData = (flags, counter) => {
  const result = Buffer.alloc(37);
  hash(rpId).copy(result);
  result[32] = flags;
  result.writeUInt32BE(counter, 33);
  return result;
};
const registrationAuthData = Buffer.concat([
  authData(0x45, 0), Buffer.alloc(16),
  Buffer.from([0, credentialId.length]), credentialId, cose,
]);
const backedUpRegistrationAuthData = Buffer.from(registrationAuthData);
backedUpRegistrationAuthData[32] = 0x5d;
const clientData = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
const registration = {
  id: b64(credentialId), rawId: b64(credentialId), type: 'public-key',
  response: {
    clientDataJSON: b64(clientData('webauthn.create', registrationChallenge)),
    attestationObject: b64(encodeCBOR(new Map([['fmt', 'none'], ['authData', registrationAuthData], ['attStmt', new Map()]]))),
    transports: ['internal'],
  },
  clientExtensionResults: {},
};
const backedUpRegistration = structuredClone(registration);
backedUpRegistration.response.attestationObject = b64(encodeCBOR(new Map([['fmt', 'none'], ['authData', backedUpRegistrationAuthData], ['attStmt', new Map()]])));
const noUvRegistration = structuredClone(registration);
const noUvRegistrationAuthData = Buffer.from(registrationAuthData);
noUvRegistrationAuthData[32] &= ~0x04;
noUvRegistration.response.attestationObject = b64(encodeCBOR(new Map([['fmt', 'none'], ['authData', noUvRegistrationAuthData], ['attStmt', new Map()]])));
const badAttestationStatement = structuredClone(registration);
badAttestationStatement.response.attestationObject = b64(encodeCBOR(new Map([['fmt', 'none'], ['authData', registrationAuthData], ['attStmt', new Map([['sig', Buffer.alloc(8)]])]])));
const assertionData = authData(0x05, 1);
const assertionClientData = clientData('webauthn.get', authenticationChallenge);
const assertion = {
  id: b64(credentialId), rawId: b64(credentialId), type: 'public-key',
  response: {
    clientDataJSON: b64(assertionClientData), authenticatorData: b64(assertionData),
    signature: b64(sign('sha256', Buffer.concat([assertionData, hash(assertionClientData)]), privateKey)),
    userHandle: b64(Buffer.from(userId)),
  },
  clientExtensionResults: {},
};
const zeroCounterData = authData(0x05, 0);
const zeroCounterAssertion = structuredClone(assertion);
zeroCounterAssertion.response.authenticatorData = b64(zeroCounterData);
zeroCounterAssertion.response.signature = b64(sign('sha256', Buffer.concat([zeroCounterData, hash(assertionClientData)]), privateKey));
const backedUpData = authData(0x1d, 0);
const backedUpAssertion = structuredClone(assertion);
backedUpAssertion.response.authenticatorData = b64(backedUpData);
backedUpAssertion.response.signature = b64(sign('sha256', Buffer.concat([backedUpData, hash(assertionClientData)]), privateKey));
const registered = await verifyRegistrationResponse({ response: registration, expectedChallenge: registrationChallenge, expectedOrigin: origin, expectedRPID: rpId, requireUserVerification: true });
if (!registered.verified || !Buffer.from(registered.registrationInfo.credential.publicKey).equals(cose)) throw new Error('SimpleWebAuthn registration failed');
const backedUpRegistered = await verifyRegistrationResponse({ response: backedUpRegistration, expectedChallenge: registrationChallenge, expectedOrigin: origin, expectedRPID: rpId, requireUserVerification: true });
if (!backedUpRegistered.verified || !backedUpRegistered.registrationInfo.credentialBackedUp) throw new Error('SimpleWebAuthn backed-up registration failed');
const authenticated = await verifyAuthenticationResponse({ response: assertion, expectedChallenge: authenticationChallenge, expectedOrigin: origin, expectedRPID: rpId, credential: registered.registrationInfo.credential, requireUserVerification: true });
if (!authenticated.verified || authenticated.authenticationInfo.newCounter !== 1) throw new Error('SimpleWebAuthn authentication failed');
const zeroCounter = await verifyAuthenticationResponse({ response: zeroCounterAssertion, expectedChallenge: authenticationChallenge, expectedOrigin: origin, expectedRPID: rpId, credential: registered.registrationInfo.credential, requireUserVerification: true });
if (!zeroCounter.verified || zeroCounter.authenticationInfo.newCounter !== 0) throw new Error('SimpleWebAuthn zero counter failed');
const backedUp = await verifyAuthenticationResponse({ response: backedUpAssertion, expectedChallenge: authenticationChallenge, expectedOrigin: origin, expectedRPID: rpId, credential: backedUpRegistered.registrationInfo.credential, requireUserVerification: true });
if (!backedUp.verified || backedUp.authenticationInfo.newCounter !== 0 || !backedUp.authenticationInfo.credentialBackedUp) throw new Error('SimpleWebAuthn backed-up assertion failed');

const edKeyPair = generateKeyPairSync('ed25519');
const edCredentialId = randomBytes(32);
const edJwk = edKeyPair.publicKey.export({ format: 'jwk' });
const edCose = Buffer.from(encodeCBOR(new Map([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(edJwk.x, 'base64url')]])));
const edRegistration = structuredClone(registration);
edRegistration.id = edRegistration.rawId = b64(edCredentialId);
edRegistration.response.attestationObject = b64(encodeCBOR(new Map([
  ['fmt', 'none'], ['authData', Buffer.concat([authData(0x45, 0), Buffer.alloc(16), Buffer.from([0, edCredentialId.length]), edCredentialId, edCose])], ['attStmt', new Map()],
])));
const edAssertion = structuredClone(assertion);
edAssertion.id = edAssertion.rawId = b64(edCredentialId);
edAssertion.response.signature = b64(sign(null, Buffer.concat([assertionData, hash(assertionClientData)]), edKeyPair.privateKey));
const edRegistered = await verifyRegistrationResponse({ response: edRegistration, expectedChallenge: registrationChallenge, expectedOrigin: origin, expectedRPID: rpId, requireUserVerification: true });
if (!edRegistered.verified) throw new Error('SimpleWebAuthn Ed25519 registration failed');
const edAuthenticated = await verifyAuthenticationResponse({ response: edAssertion, expectedChallenge: authenticationChallenge, expectedOrigin: origin, expectedRPID: rpId, credential: edRegistered.registrationInfo.credential, requireUserVerification: true });
if (!edAuthenticated.verified) throw new Error('SimpleWebAuthn Ed25519 authentication failed');

const es512KeyPair = generateKeyPairSync('ec', { namedCurve: 'secp521r1' });
const es512Id = randomBytes(32);
const es512Jwk = es512KeyPair.publicKey.export({ format: 'jwk' });
const es512Cose = Buffer.from(encodeCBOR(new Map([[1, 2], [3, -36], [-1, 3], [-2, Buffer.from(es512Jwk.x, 'base64url')], [-3, Buffer.from(es512Jwk.y, 'base64url')]])));
const es512Registration = structuredClone(registration);
es512Registration.id = es512Registration.rawId = b64(es512Id);
es512Registration.response.attestationObject = b64(encodeCBOR(new Map([
  ['fmt', 'none'], ['authData', Buffer.concat([authData(0x45, 0), Buffer.alloc(16), Buffer.from([0, es512Id.length]), es512Id, es512Cose])], ['attStmt', new Map()],
])));
const es512Assertion = structuredClone(assertion);
es512Assertion.id = es512Assertion.rawId = b64(es512Id);
es512Assertion.response.signature = b64(sign('sha512', Buffer.concat([assertionData, hash(assertionClientData)]), es512KeyPair.privateKey));
const es512Registered = await verifyRegistrationResponse({ response: es512Registration, expectedChallenge: registrationChallenge, expectedOrigin: origin, expectedRPID: rpId, requireUserVerification: true });
if (!es512Registered.verified) throw new Error('SimpleWebAuthn ES512 registration failed');
const es512Authenticated = await verifyAuthenticationResponse({ response: es512Assertion, expectedChallenge: authenticationChallenge, expectedOrigin: origin, expectedRPID: rpId, credential: es512Registered.registrationInfo.credential, requireUserVerification: true });
if (!es512Authenticated.verified) throw new Error('SimpleWebAuthn ES512 authentication failed');

const rsaKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
const rsaJwk = rsaKeyPair.publicKey.export({ format: 'jwk' });
async function rsaVector(algorithm, hashName, padding) {
  const id = randomBytes(32);
  const key = Buffer.from(encodeCBOR(new Map([[1, 3], [3, algorithm], [-1, Buffer.from(rsaJwk.n, 'base64url')], [-2, Buffer.from(rsaJwk.e, 'base64url')]])));
  const reg = structuredClone(registration);
  reg.id = reg.rawId = b64(id);
  reg.response.attestationObject = b64(encodeCBOR(new Map([
    ['fmt', 'none'], ['authData', Buffer.concat([authData(0x45, 0), Buffer.alloc(16), Buffer.from([0, id.length]), id, key])], ['attStmt', new Map()],
  ])));
  const assertion = structuredClone(edAssertion);
  assertion.id = assertion.rawId = b64(id);
  assertion.response.signature = b64(sign(hashName, Buffer.concat([assertionData, hash(assertionClientData)]), { key: rsaKeyPair.privateKey, padding, saltLength: padding === constants.RSA_PKCS1_PSS_PADDING ? constants.RSA_PSS_SALTLEN_DIGEST : undefined }));
  const registered = await verifyRegistrationResponse({ response: reg, expectedChallenge: registrationChallenge, expectedOrigin: origin, expectedRPID: rpId, requireUserVerification: true });
  if (!registered.verified) throw new Error(`SimpleWebAuthn algorithm ${algorithm} registration failed`);
  const authenticated = await verifyAuthenticationResponse({ response: assertion, expectedChallenge: authenticationChallenge, expectedOrigin: origin, expectedRPID: rpId, credential: registered.registrationInfo.credential, requireUserVerification: true });
  if (!authenticated.verified) throw new Error(`SimpleWebAuthn algorithm ${algorithm} authentication failed`);
  return { credentialId: b64(id), publicKey: b64(key), registration: reg, assertion };
}
const rs256 = await rsaVector(-257, 'sha256', constants.RSA_PKCS1_PADDING);
const ps256 = await rsaVector(-37, 'sha256', constants.RSA_PKCS1_PSS_PADDING);
const ps384 = await rsaVector(-38, 'sha384', constants.RSA_PKCS1_PSS_PADDING);
const ps512 = await rsaVector(-39, 'sha512', constants.RSA_PKCS1_PSS_PADDING);
const rs384 = await rsaVector(-258, 'sha384', constants.RSA_PKCS1_PADDING);
const rs512 = await rsaVector(-259, 'sha512', constants.RSA_PKCS1_PADDING);
const rs1 = await rsaVector(-65535, 'sha1', constants.RSA_PKCS1_PADDING);
const invalidTokenBindingRegistration = structuredClone(registration);
invalidTokenBindingRegistration.response.clientDataJSON = b64(Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: registrationChallenge, origin, tokenBinding: { status: 'invalid' } })));
const signedPs256WithClientData = (extra) => {
  const response = structuredClone(ps256.assertion);
  const data = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: authenticationChallenge, origin, ...extra }));
  response.response.clientDataJSON = b64(data);
  response.response.signature = b64(sign('sha256', Buffer.concat([assertionData, hash(data)]), { key: rsaKeyPair.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }));
  return response;
};
const invalidTokenBindingAssertion = signedPs256WithClientData({ tokenBinding: { status: 'invalid' } });
const crossOriginAssertion = signedPs256WithClientData({ crossOrigin: true });
const crossOriginVerified = await verifyAuthenticationResponse({ response: crossOriginAssertion, expectedChallenge: authenticationChallenge, expectedOrigin: origin, expectedRPID: rpId, credential: { id: ps256.credentialId, publicKey: Buffer.from(ps256.publicKey, 'base64url'), counter: 0 }, requireUserVerification: true });
if (!crossOriginVerified.verified) throw new Error('SimpleWebAuthn crossOrigin fixture failed');

writeFileSync(new URL('./webauthn-interop.json', import.meta.url), `${JSON.stringify({
  rpId, origin, userId, registrationChallenge, authenticationChallenge,
  credentialId: b64(credentialId), publicKey: b64(cose), counter: 0,
  registration, assertion, zeroCounterAssertion, backedUpRegistration, backedUpAssertion, noUvRegistration, badAttestationStatement,
  eddsa: { credentialId: b64(edCredentialId), publicKey: b64(edCose), registration: edRegistration, assertion: edAssertion },
  es512: { credentialId: b64(es512Id), publicKey: b64(es512Cose), registration: es512Registration, assertion: es512Assertion },
  rs256, ps256, ps384, ps512, rs384, rs512, rs1,
  invalidTokenBindingRegistration, invalidTokenBindingAssertion, crossOriginAssertion,
}, null, 2)}\n`);
