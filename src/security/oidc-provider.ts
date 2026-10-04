import * as oidc from 'openid-client';
import type { AppConfig } from '../config/env.js';
import { AppError } from '../exception/app-error.js';
export interface Challenge {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  agencyId: string;
}
export interface Tokens {
  accessToken: string;
  refreshToken: string;
  subject?: string;
}
export interface IdentityProvider {
  authorize(challenge: Challenge): Promise<string>;
  exchange(url: URL, challenge: Challenge): Promise<Tokens>;
  refresh(refreshToken: string): Promise<Tokens>;
  revoke(refreshToken: string): Promise<void>;
}
export class OidcProvider implements IdentityProvider {
  constructor(
    private readonly client: oidc.Configuration,
    private readonly scope: string,
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
    return { provider: new OidcProvider(client, config.OIDC_SCOPE), jwksUri: metadata.jwks_uri };
  }
  async authorize(challenge: Challenge) {
    return oidc.buildAuthorizationUrl(this.client, {
      redirect_uri: challenge.redirectUri,
      scope: this.scope,
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
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        subject: tokens.claims()?.sub,
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
