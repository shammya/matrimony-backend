import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import * as oidc from 'openid-client';
import { AppError } from '../exception/app-error.js';

/** What a Google sign-in attempt needs to remember between leaving for Google and coming back. */
export interface GoogleAttempt {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
}

/** Who Google says the person is. Only a confirmed email may ever be used. */
export interface GoogleProfile {
  /** Google's stable id for the person. The email can change; this cannot. */
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string | undefined;
}

/** The boundary to Google, so everything above it can be tested without the network. */
export interface GoogleIdentityProvider {
  authorize(attempt: GoogleAttempt): Promise<string>;
  exchange(url: URL, attempt: GoogleAttempt): Promise<GoogleProfile>;
}

export interface GoogleSettings {
  clientId: string;
  clientSecret: string;
  timeoutMs: number;
  /** Google's address. Only a test points it elsewhere (a local stand-in for Google). */
  issuer?: string;
  /** Lets a test stand-in use plain http. Never set outside tests. */
  allowInsecure?: boolean;
}

const GOOGLE = 'https://accounts.google.com';

/**
 * Sign-in with Google by the authorization-code flow with PKCE, state and nonce. The library
 * checks the state, the nonce, the code verifier and the ID token's issuer, audience (our client id)
 * and expiry. It does not check the token's signature, because the OIDC rules let a token that came
 * straight from the token endpoint over TLS rely on that connection. We check it anyway, against
 * Google's published keys, so a token is trusted only if Google signed it. Google's own access and
 * refresh tokens are never kept: they are not needed once the person's identity is known.
 */
export class GoogleProvider implements GoogleIdentityProvider {
  private configuration: Promise<oidc.Configuration> | undefined;
  private keys: JWTVerifyGetKey | undefined;

  constructor(private readonly settings: GoogleSettings) {}

  /** Found on first use and remembered, so the server starts even when Google cannot be reached. */
  private discover(): Promise<oidc.Configuration> {
    this.configuration ??= oidc
      .discovery(
        new URL(this.settings.issuer ?? GOOGLE),
        this.settings.clientId,
        { client_secret: this.settings.clientSecret },
        oidc.ClientSecretPost(this.settings.clientSecret),
        {
          timeout: this.settings.timeoutMs / 1000,
          ...(this.settings.allowInsecure ? { execute: [oidc.allowInsecureRequests] } : {}),
        },
      )
      .catch((error: unknown) => {
        // Try again on the next sign-in rather than remembering a failure.
        this.configuration = undefined;
        throw error;
      });
    return this.configuration;
  }

  async authorize(attempt: GoogleAttempt): Promise<string> {
    let configuration: oidc.Configuration;
    try {
      configuration = await this.discover();
    } catch {
      throw new AppError(502, 'GOOGLE_UNAVAILABLE');
    }
    return oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: attempt.redirectUri,
      scope: 'openid email profile',
      code_challenge: await oidc.calculatePKCECodeChallenge(attempt.verifier),
      code_challenge_method: 'S256',
      state: attempt.state,
      nonce: attempt.nonce,
      // Let the person choose the Google account, rather than using whichever is signed in.
      prompt: 'select_account',
    }).href;
  }

  async exchange(url: URL, attempt: GoogleAttempt): Promise<GoogleProfile> {
    try {
      const configuration = await this.discover();
      const tokens = await oidc.authorizationCodeGrant(configuration, url, {
        pkceCodeVerifier: attempt.verifier,
        expectedState: attempt.state,
        expectedNonce: attempt.nonce,
        idTokenExpected: true,
      });
      const metadata = configuration.serverMetadata();
      if (!tokens.id_token || !metadata.jwks_uri) throw new Error('No ID token');
      this.keys ??= createRemoteJWKSet(new URL(metadata.jwks_uri), {
        timeoutDuration: this.settings.timeoutMs,
        cooldownDuration: 30000,
      });
      await jwtVerify(tokens.id_token, this.keys, {
        issuer: metadata.issuer,
        audience: this.settings.clientId,
        algorithms: ['RS256'],
        clockTolerance: 5,
      });
      const claims = tokens.claims();
      if (!claims || typeof claims.sub !== 'string' || !claims.sub) throw new Error('No subject');
      const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
      return {
        subject: claims.sub,
        email,
        // Only an explicit true counts. A missing or false flag means Google does not vouch for it.
        emailVerified: claims.email_verified === true && email !== '',
        name: typeof claims.name === 'string' ? claims.name : undefined,
      };
    } catch {
      throw new AppError(401, 'GOOGLE_AUTH_FAILED');
    }
  }
}
