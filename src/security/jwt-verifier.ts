import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Identity } from '../bo/identity.js';
import { AppError } from '../exception/app-error.js';
export class JwtVerifier {
  constructor(
    private readonly key: JWTVerifyGetKey,
    private readonly issuer: string,
    private readonly audience: string,
    private readonly requiredScope: string,
  ) {}
  async verify(token: string): Promise<Identity> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['RS256', 'ES256'],
        requiredClaims: ['sub', 'exp', 'iat'],
        clockTolerance: 5,
      });
      const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ') : [];
      if (!payload.sub || !payload.exp || !scopes.includes(this.requiredScope))
        throw new Error('Invalid access claims');
      return { issuer: this.issuer, subject: payload.sub, expiresAt: payload.exp };
    } catch {
      throw new AppError(401, 'INVALID_ACCESS_TOKEN');
    }
  }
  static remote(jwksUri: string, issuer: string, audience: string, scope: string, timeout: number) {
    if (new URL(jwksUri).protocol !== 'https:') throw new Error('JWKS requires HTTPS');
    return new JwtVerifier(
      createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: timeout, cooldownDuration: 30000 }),
      issuer,
      audience,
      scope,
    );
  }
}
