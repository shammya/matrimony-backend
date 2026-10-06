import * as oidc from 'openid-client';
import type { AppConfig } from '../config/env.js';
import { AppError } from '../exception/app-error.js';
export interface Challenge {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  agencyId: string;
  /** Registration also asks the provider for the verified phone number. */
  intent: 'login' | 'register';
}
export interface Tokens {
  accessToken: string;
  refreshToken: string;
  subject?: string;
  /** The phone number the provider verified with a one-time code, when it says so. */
  phone?: string;
  /** The names (never the values) of the identity claims received, to explain a missing phone. */
  claimNames?: string[];
}
export interface IdentityProvider {
  authorize(challenge: Challenge): Promise<string>;
  exchange(url: URL, challenge: Challenge): Promise<Tokens>;
  refresh(refreshToken: string): Promise<Tokens>;
  revoke(refreshToken: string): Promise<void>;
}
/**
 * The phone number to trust from the identity claims, or undefined.
 *
 * - If the provider says the number is verified, it is.
 * - If it says the number is NOT verified, it is not, whatever else is true.
 * - If it says nothing (Auth0 omits the flag for passwordless SMS users), the number counts only
 *   when the sign-in came through the phone connection itself. That sign-in's subject begins with
 *   the connection's name (`sms|...`), and no one can hold such an identity without having typed
 *   the one-time code sent to that very number. A sign-in through any other connection, whose
 *   phone could be anything, is never trusted this way.
 */
export function verifiedPhone(
  claims: { sub?: unknown; phone_number?: unknown; phone_number_verified?: unknown } | undefined,
  phoneConnection?: string,
): string | undefined {
  if (!claims || typeof claims.phone_number !== 'string') return undefined;
  if (claims.phone_number_verified === true) return claims.phone_number;
  if (claims.phone_number_verified === false) return undefined;
  const bySmsSignIn =
    phoneConnection !== undefined &&
    typeof claims.sub === 'string' &&
    claims.sub.startsWith(`${phoneConnection}|`);
  return bySmsSignIn ? claims.phone_number : undefined;
}

export class OidcProvider implements IdentityProvider {
  constructor(
    private readonly client: oidc.Configuration,
    private readonly scope: string,
    /** Sends the person straight to this sign-in method (for example the SMS connection). */
    private readonly registerConnection?: string,
  ) {}
  static async discover(config: AppConfig) {
    const client = await oidc.discovery(
      new URL(config.OIDC_ISSUER),
      config.OIDC_CLIENT_ID,
      { client_secret: config.OIDC_CLIENT_SECRET },
      oidc.ClientSecretPost(config.OIDC_CLIENT_SECRET),
      { timeout: config.IO_TIMEOUT_MS / 1000 },
    );
    const metadata = client.serverMetadata();
    if (!metadata.jwks_uri || !metadata.revocation_endpoint || !metadata.supportsPKCE())
      throw new Error('Provider must support JWKS, revocation and S256 PKCE');
    for (const endpoint of [
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      metadata.jwks_uri,
      metadata.revocation_endpoint,
    ])
      if (!endpoint || new URL(endpoint).protocol !== 'https:')
        throw new Error('OIDC endpoints require HTTPS');
    return {
      provider: new OidcProvider(client, config.OIDC_SCOPE, config.OIDC_REGISTER_CONNECTION),
      jwksUri: metadata.jwks_uri,
    };
  }
  async authorize(challenge: Challenge) {
    return oidc.buildAuthorizationUrl(this.client, {
      redirect_uri: challenge.redirectUri,
      // Only registration needs the phone number, so only it asks for it.
      scope: challenge.intent === 'register' ? `${this.scope} phone` : this.scope,
      ...(challenge.intent === 'register' && this.registerConnection
        ? { connection: this.registerConnection }
        : {}),
      code_challenge: await oidc.calculatePKCECodeChallenge(challenge.verifier),
      code_challenge_method: 'S256',
      state: challenge.state,
      nonce: challenge.nonce,
    }).href;
  }
  async exchange(url: URL, challenge: Challenge): Promise<Tokens> {
    try {
      const tokens = await oidc.authorizationCodeGrant(this.client, url, {
        pkceCodeVerifier: challenge.verifier,
        expectedState: challenge.state,
        expectedNonce: challenge.nonce,
        idTokenExpected: true,
      });
      if (!tokens.refresh_token || tokens.token_type.toLowerCase() !== 'bearer')
        throw new Error('Missing refresh token');
      const claims = tokens.claims();
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        subject: claims?.sub,
        claimNames: Object.keys(claims ?? {}),
        // Only a number the provider verified counts (see verifiedPhone).
        phone: verifiedPhone(claims, this.registerConnection),
      };
    } catch {
      throw new AppError(401, 'OAUTH_EXCHANGE_FAILED');
    }
  }
  async refresh(refreshToken: string): Promise<Tokens> {
    try {
      const tokens = await oidc.refreshTokenGrant(this.client, refreshToken);
      if (
        !tokens.refresh_token ||
        tokens.refresh_token === refreshToken ||
        tokens.token_type.toLowerCase() !== 'bearer'
      )
        throw new Error('Refresh rotation required');
      return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
    } catch {
      throw new AppError(401, 'REFRESH_FAILED_LOGIN_REQUIRED');
    }
  }
  async revoke(refreshToken: string) {
    await oidc.tokenRevocation(this.client, refreshToken, { token_type_hint: 'refresh_token' });
  }
}
