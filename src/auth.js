import { createHash, randomBytes } from 'node:crypto';
import { InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

const ACCESS_TTL = 60 * 60; // seconds
const REFRESH_TTL = 30 * 24 * 60 * 60;
const PENDING_TTL = 10 * 60;

const random = () => randomBytes(32).toString('base64url');
const hash = (s) => createHash('sha256').update(s).digest('base64url');
const now = () => Math.floor(Date.now() / 1000);

// Removes and returns a live entry; every code/state is single-use.
function take(map, key) {
  const entry = map.get(key);
  map.delete(key);
  return entry && entry.expiresAt > now() ? entry : undefined;
}

function prune(map) {
  for (const [k, v] of map) if (v.expiresAt <= now()) map.delete(k);
}

const page = (res, status, text) => res.status(status).type('text/plain').send(text);

// OAuth 2.1 authorization server for exactly one client (claude.ai). Users sign in with Google;
// only OWNER_EMAIL is accepted. Codes, tokens and states are stored only as SHA-256 hashes.
export class Auth {
  #pending = new Map(); // Google `state` -> in-flight sign-in
  #codes = new Map(); // hash(code) -> authorization code grant
  #accessTokens = new Map(); // hash(token) -> { clientId, expiresAt }

  constructor({ config, store, google }) {
    this.store = store;
    this.google = google;
    this.ownerEmail = config.ownerEmail;
    this.resourceUrl = new URL('/mcp', config.publicUrl);
    const client = {
      client_id: config.mcpClientId,
      client_secret: config.mcpClientSecret,
      redirect_uris: config.redirectUris,
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
    // No registerClient: dynamic client registration is disabled.
    this.clientsStore = { getClient: (id) => (id === client.client_id ? client : undefined) };
  }

  async authorize(client, params, res) {
    if (params.resource && params.resource.href !== this.resourceUrl.href) {
      throw new InvalidTargetError('Unknown resource');
    }
    res.redirect(this.#startGoogle({ kind: 'login', clientId: client.client_id, params }, this.ownerEmail));
  }

  // One-time Google consent URL that adds another Gmail account.
  linkUrl() {
    return this.#startGoogle({ kind: 'link' });
  }

  #startGoogle(entry, loginHint) {
    prune(this.#pending);
    const state = random();
    const verifier = random();
    this.#pending.set(state, { ...entry, verifier, expiresAt: now() + PENDING_TTL });
    return this.google.authUrl({ state, codeChallenge: hash(verifier), loginHint });
  }

  // Express handler for Google redirecting back to us.
  googleCallback = async (req, res) => {
    const entry = take(this.#pending, String(req.query.state ?? ''));
    if (!entry) return page(res, 400, 'This sign-in link is invalid or has expired.');
    if (!req.query.code) return page(res, 400, 'Google sign-in was cancelled.');

    let account;
    try {
      account = await this.google.exchangeCode(String(req.query.code), entry.verifier);
    } catch (e) {
      return page(res, 400, `Google sign-in failed: ${e.message}`);
    }
    if (entry.kind === 'login' && account.email !== this.ownerEmail) {
      await this.google.revoke(account.refreshToken);
      return page(res, 403, `${account.email} is not allowed to use this server.`);
    }
    this.store.data.accounts[account.email] = { refreshToken: account.refreshToken, linkedAt: new Date().toISOString() };
    this.store.save();
    if (entry.kind === 'link') return page(res, 200, `Linked ${account.email}. You can close this tab.`);

    prune(this.#codes);
    const code = random();
    this.#codes.set(hash(code), { clientId: entry.clientId, params: entry.params, expiresAt: now() + PENDING_TTL });
    const redirect = new URL(entry.params.redirectUri);
    redirect.searchParams.set('code', code);
    if (entry.params.state) redirect.searchParams.set('state', entry.params.state);
    res.redirect(redirect.href);
  };

  async challengeForAuthorizationCode(client, code) {
    const entry = this.#codes.get(hash(code));
    if (!entry || entry.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
    return entry.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
    const entry = take(this.#codes, hash(code));
    if (!entry || entry.clientId !== client.client_id || redirectUri !== entry.params.redirectUri) {
      throw new InvalidGrantError('Invalid authorization code');
    }
    return this.#issueTokens(client.client_id);
  }

  // Refresh tokens rotate: each one works exactly once.
  async exchangeRefreshToken(client, refreshToken) {
    const key = hash(refreshToken);
    const entry = this.store.data.refreshTokens[key];
    delete this.store.data.refreshTokens[key];
    if (!entry || entry.clientId !== client.client_id || entry.expiresAt <= now()) {
      this.store.save();
      throw new InvalidGrantError('Invalid refresh token');
    }
    return this.#issueTokens(client.client_id);
  }

  async verifyAccessToken(token) {
    const entry = this.#accessTokens.get(hash(token));
    if (!entry || entry.expiresAt <= now()) throw new InvalidTokenError('Invalid or expired access token');
    return { token, clientId: entry.clientId, scopes: [], expiresAt: entry.expiresAt, resource: this.resourceUrl };
  }

  async revokeToken(client, { token }) {
    const key = hash(token);
    this.#accessTokens.delete(key);
    if (this.store.data.refreshTokens[key]?.clientId === client.client_id) {
      delete this.store.data.refreshTokens[key];
      this.store.save();
    }
  }

  #issueTokens(clientId) {
    prune(this.#accessTokens);
    const { refreshTokens } = this.store.data;
    for (const [k, v] of Object.entries(refreshTokens)) if (v.expiresAt <= now()) delete refreshTokens[k];

    const accessToken = random();
    const refreshToken = random();
    this.#accessTokens.set(hash(accessToken), { clientId, expiresAt: now() + ACCESS_TTL });
    refreshTokens[hash(refreshToken)] = { clientId, expiresAt: now() + REFRESH_TTL };
    this.store.save();
    return { access_token: accessToken, token_type: 'bearer', expires_in: ACCESS_TTL, refresh_token: refreshToken };
  }
}
