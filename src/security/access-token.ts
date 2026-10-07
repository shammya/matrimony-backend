import { createPrivateKey, createPublicKey, randomUUID, type KeyObject } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { AppError } from '../exception/app-error.js';

/**
 * The short-lived access token the API accepts. This service is its only issuer and its only
 * verifier, so the names below are fixed values, not settings. The token says who the person is
 * (`sub` is the account id) and nothing else: a role or an agency inside a token is never used to
 * authorize anything, and the session behind the token can be ended at any moment.
 */
export const ACCESS_TOKEN_ISSUER = 'matrimony';
export const ACCESS_TOKEN_AUDIENCE = 'matrimony-api';
export const ACCESS_TOKEN_SCOPE = 'matrimony:api';
const ALGORITHM = 'ES256';

export interface IssuedToken {
  token: string;
  /** Seconds since the epoch. */
  expiresAt: number;
}

/**
 * Reads the signing key from configuration. Accepts a PKCS#8 PEM, with real line breaks or with
 * the two characters `\n` (which is how a PEM is usually written on one line in an env file).
 * Only an elliptic-curve P-256 key is accepted, the key type ES256 needs.
 */
export function parseSigningKey(value: string): KeyObject {
  const key = createPrivateKey(value.includes('\\n') ? value.replace(/\\n/g, '\n') : value);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw new Error('The signing key must be an elliptic-curve P-256 private key');
  return key;
}

export class AccessTokens {
  private readonly publicKey: KeyObject;

  constructor(
    private readonly privateKey: KeyObject,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.publicKey = createPublicKey(privateKey);
  }

  async issue(accountId: string, ttlSeconds: number): Promise<IssuedToken> {
    const issuedAt = Math.floor(this.now() / 1000);
    const expiresAt = issuedAt + ttlSeconds;
    const token = await new SignJWT({ scope: ACCESS_TOKEN_SCOPE })
      .setProtectedHeader({ alg: ALGORITHM, typ: 'at+jwt' })
      .setIssuer(ACCESS_TOKEN_ISSUER)
      .setAudience(ACCESS_TOKEN_AUDIENCE)
      .setSubject(accountId)
      .setJti(randomUUID())
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(this.privateKey);
    return { token, expiresAt };
  }

  /** The account id the token was issued to. Throws 401 for anything that is not a valid token. */
  async verify(token: string): Promise<{ accountId: string; expiresAt: number }> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        issuer: ACCESS_TOKEN_ISSUER,
        audience: ACCESS_TOKEN_AUDIENCE,
        algorithms: [ALGORITHM],
        typ: 'at+jwt',
        requiredClaims: ['sub', 'exp', 'iat', 'jti'],
        clockTolerance: 5,
        currentDate: new Date(this.now()),
      });
      const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ') : [];
      if (!payload.sub || !payload.exp || !scopes.includes(ACCESS_TOKEN_SCOPE))
        throw new Error('Invalid access claims');
      return { accountId: payload.sub, expiresAt: payload.exp };
    } catch {
      throw new AppError(401, 'INVALID_ACCESS_TOKEN');
    }
  }
}
