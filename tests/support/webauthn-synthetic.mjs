import { createHash, generateKeyPairSync, randomBytes, sign, createPrivateKey } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const requireFromServer = createRequire(import.meta.resolve('@simplewebauthn/server'));
const { encodeCBOR } = requireFromServer('@levischuck/tiny-cbor');
const input = JSON.parse(process.env.SUPLEX_SYNTHETIC_INPUT ?? await new Promise((resolve) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => resolve(data));
}));
const emit = (value) => {
  const output = JSON.stringify(value);
  if (process.env.SUPLEX_SYNTHETIC_OUTPUT) writeFileSync(process.env.SUPLEX_SYNTHETIC_OUTPUT, output, { mode: 0o600 });
  else process.stdout.write(output);
};
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const hash = (bytes) => createHash('sha256').update(bytes).digest();
const authData = (rpId, flags, counter) => {
  const bytes = Buffer.alloc(37);
  hash(rpId).copy(bytes);
  bytes[32] = flags;
  bytes.writeUInt32BE(counter, 33);
  return bytes;
};
const clientData = (type, challenge, origin) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
if (input.mode === 'register') {
  const options = input.options;
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const id = randomBytes(32);
  const cose = Buffer.from(encodeCBOR(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]])));
  const data = Buffer.concat([authData(options.rp.id, 0x45, input.counter ?? 0), Buffer.alloc(16), Buffer.from([0, id.length]), id, cose]);
  const response = {
    id: b64(id), rawId: b64(id), type: 'public-key',
    response: {
      clientDataJSON: b64(clientData('webauthn.create', options.challenge, input.origin)),
      attestationObject: b64(encodeCBOR(new Map([['fmt', 'none'], ['authData', data], ['attStmt', new Map()]]))),
      transports: ['internal'],
    },
    clientExtensionResults: {},
  };
  emit({ response, privateKeyPem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), credentialId: b64(id) });
} else if (input.mode === 'authenticate') {
  const options = input.options;
  const data = authData(options.rpId, 0x05, input.counter ?? 1);
  const client = clientData('webauthn.get', options.challenge, input.origin);
  const signature = sign('sha256', Buffer.concat([data, hash(client)]), createPrivateKey(input.privateKeyPem));
  const response = {
    id: input.credentialId, rawId: input.credentialId, type: 'public-key',
    response: { clientDataJSON: b64(client), authenticatorData: b64(data), signature: b64(signature), userHandle: null },
    clientExtensionResults: {},
  };
  emit({ response });
} else {
  throw new Error('Expected register or authenticate mode');
}
