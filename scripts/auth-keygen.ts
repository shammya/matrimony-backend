import { generateKeyPairSync } from 'node:crypto';

// Prints a new access-token signing key (elliptic-curve P-256, PKCS#8 PEM) as an env line.
// Nothing is written to disk: copy the line into .env for development, or into the secret manager
// for a deployed environment. Replacing the key signs everyone out of their current access
// tokens; their sessions continue and the next refresh issues a token signed with the new key.
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim();
console.log(`AUTH_JWT_PRIVATE_KEY="${pem.replace(/\n/g, '\\n')}"`);
