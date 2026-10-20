import { createHash, randomBytes } from 'node:crypto';
import { InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

const ACCESS_TTL = 60 * 60; // seconds
const REFRESH_TTL = 30 * 24 * 60 * 60;
const PENDING_TTL = 10 * 60;

export const random = () => randomBytes(32).toString('base64url');
export const sha256 = (s) => createHash('sha256').update(s).digest('base64url');
const now = () => Math.floor(Date.now() / 1000);

// Single-use: removes the entry and returns it only if unexpired.
function take(map, key) {
  const entry = map.get(key);
  map.delete(key);
  return entry?.expiresAt > now() ? entry : undefined;
}

function put(map, key, value, ttl) {
  for (const [k, v] of map) if (v.expiresAt <= now()) map.delete(k);
  map.set(key, { ...value, expiresAt: now() + ttl });
}

// OAuth 2.1 authorization server for one static client (claude.ai). The user signs in with Google
// and only OWNER_EMAIL is accepted. Codes and tokens are kept only as SHA-256 hashes.
export class OAuth {
  #pending = new Map(); // Google state -> claude.ai authorization request
  #codes = new Map(); // hash(code) -> authorization request
  #accessTokens = new Map(); // hash(token) -> {}

  constructor({ config, store, google }) {
    Object.assign(this, { store, google, ownerEmail: config.ownerEmail, clientId: config.mcpClientId });
    this.resourceUrl = new URL('/mcp', config.publicUrl);
    this.callbackUrl = new URL('/oauth/google/callback', config.publicUrl).href;
    const client = {
      client_id: config.mcpClientId,
      client_secret: config.mcpClientSecret,
      redirect_uris: config.redirectUris,
    };
    // No registerClient: dynamic client registration is disabled.
    this.clientsStore = { getClient: (id) => (id === client.client_id ? client : undefined) };
  }

  async authorize(_client, params, res) {
    if (params.resource && params.resource.href !== this.resourceUrl.href) throw new InvalidTargetError('Unknown resource');
    const state = random();
    const codeVerifier = random();
    put(this.#pending, state, { params, codeVerifier }, PENDING_TTL);
    res.redirect(
      this.google.authUrl({ redirectUri: this.callbackUrl, state, codeChallenge: sha256(codeVerifier), loginHint: this.ownerEmail }),
    );
  }

  googleCallback = async (req, res) => {
    const reply = (status, text) => res.status(status).type('text/plain').send(text);
    const pending = take(this.#pending, String(req.query.state));
    if (!pending || !req.query.code) return reply(400, 'Sign-in link is invalid, expired or was cancelled.');
    let email;
    try {
      ({ email } = await this.google.exchangeCode({
        code: String(req.query.code),
        codeVerifier: pending.codeVerifier,
        redirectUri: this.callbackUrl,
      }));
    } catch (e) {
      return reply(400, `Google sign-in failed: ${e.message}`);
    }
    if (email !== this.ownerEmail) return reply(403, `${email} is not allowed to use this server.`);

    const code = random();
    put(this.#codes, sha256(code), { params: pending.params }, PENDING_TTL);
    const redirect = new URL(pending.params.redirectUri);
    redirect.searchParams.set('code', code);
    if (pending.params.state) redirect.searchParams.set('state', pending.params.state);
    res.redirect(redirect.href);
  };

  async challengeForAuthorizationCode(_client, code) {
    const entry = this.#codes.get(sha256(code));
    if (!entry) throw new InvalidGrantError('Invalid authorization code');
    return entry.params.codeChallenge;
  }

  async exchangeAuthorizationCode(_client, code, _verifier, redirectUri) {
    const entry = take(this.#codes, sha256(code));
    if (!entry || redirectUri !== entry.params.redirectUri) throw new InvalidGrantError('Invalid authorization code');
    return this.#issueTokens();
  }

  // Refresh tokens rotate: each one works exactly once.
  async exchangeRefreshToken(_client, refreshToken) {
    const key = sha256(refreshToken);
    const entry = this.store.update(({ refreshTokens }) => {
      const e = refreshTokens[key];
      delete refreshTokens[key];
      return e;
    });
    if (!(entry?.expiresAt > now())) throw new InvalidGrantError('Invalid refresh token');
    return this.#issueTokens();
  }

  async verifyAccessToken(token) {
    const entry = this.#accessTokens.get(sha256(token));
    if (!(entry?.expiresAt > now())) throw new InvalidTokenError('Invalid or expired access token');
    return { token, clientId: this.clientId, scopes: [], expiresAt: entry.expiresAt, resource: this.resourceUrl };
  }

  async revokeToken(_client, { token }) {
    const key = sha256(token);
    this.#accessTokens.delete(key);
    this.store.update(({ refreshTokens }) => delete refreshTokens[key]);
  }

  #issueTokens() {
    const accessToken = random();
    const refreshToken = random();
    put(this.#accessTokens, sha256(accessToken), {}, ACCESS_TTL);
    this.store.update(({ refreshTokens }) => {
      for (const [k, v] of Object.entries(refreshTokens)) if (v.expiresAt <= now()) delete refreshTokens[k];
      refreshTokens[sha256(refreshToken)] = { expiresAt: now() + REFRESH_TTL };
    });
    return { access_token: accessToken, token_type: 'bearer', expires_in: ACCESS_TTL, refresh_token: refreshToken };
  }
}
