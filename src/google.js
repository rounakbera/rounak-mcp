export const GOOGLE_ENDPOINTS = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  // API base URLs used by modules, keyed by module name.
  gmail: 'https://gmail.googleapis.com/gmail/v1/users/me',
};

const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export class Google {
  #accessTokens = new Map(); // email -> { token, expiresAt }

  constructor({ clientId, clientSecret, endpoints = GOOGLE_ENDPOINTS, store }) {
    Object.assign(this, { clientId, clientSecret, endpoints, store });
  }

  // With `scopes` (linking): offline access to those APIs. Without: sign-in only.
  authUrl({ redirectUri, state, codeChallenge, scopes, loginHint }) {
    const url = new URL(this.endpoints.authUrl);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: ['openid', 'email', ...(scopes ?? [])].join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      ...(scopes && { access_type: 'offline', prompt: 'select_account consent' }),
      ...(loginHint && { login_hint: loginHint }),
    });
    return url.href;
  }

  // Returns the verified email and the raw token response.
  async exchangeCode({ code, codeVerifier, redirectUri }) {
    const t = await this.#token({ grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: redirectUri });
    // The id_token came straight from Google's token endpoint over TLS, so its claims can be
    // trusted without a signature check (OIDC Core 3.1.3.7); we still validate them.
    const claims = JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString());
    if (claims.aud !== this.clientId || !ISSUERS.includes(claims.iss) || !claims.email_verified) {
      throw new Error('Invalid Google id_token');
    }
    return { email: claims.email.toLowerCase(), tokens: t };
  }

  async revoke(token) {
    await fetch(this.endpoints.revokeUrl, { method: 'POST', body: new URLSearchParams({ token }) });
  }

  // Calls a Google API as a linked account.
  async request(email, method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${await this.#accessToken(email)}`, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Google API ${res.status}: ${json.error?.message ?? res.statusText}`);
    return json;
  }

  async #accessToken(email) {
    const cached = this.#accessTokens.get(email);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const account = this.store.read().accounts[email];
    if (!account) throw new Error(`Account ${email} is not linked`);
    const t = await this.#token({ grant_type: 'refresh_token', refresh_token: account.refreshToken }).catch((e) => {
      throw e.message.includes('invalid_grant') ? new Error(`Google access for ${email} expired or was revoked; re-link it`) : e;
    });
    this.#accessTokens.set(email, { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 });
    return t.access_token;
  }

  async #token(params) {
    const res = await fetch(this.endpoints.tokenUrl, {
      method: 'POST',
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...params }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Google token error: ${json.error ?? res.status}`);
    return json;
  }
}
