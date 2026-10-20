export const GOOGLE_ENDPOINTS = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  gmailUrl: 'https://gmail.googleapis.com/gmail/v1/users/me',
};

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export class Google {
  #accessTokens = new Map(); // email -> { token, expiresAt }

  constructor({ clientId, clientSecret, redirectUri, endpoints = GOOGLE_ENDPOINTS, store }) {
    Object.assign(this, { clientId, clientSecret, redirectUri, endpoints, store });
  }

  authUrl({ state, codeChallenge, loginHint }) {
    const url = new URL(this.endpoints.authUrl);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: `openid email ${GMAIL_SCOPE}`,
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      ...(loginHint && { login_hint: loginHint }),
    });
    return url.href;
  }

  // Exchanges a Google auth code and returns the verified account email plus its refresh token.
  async exchangeCode(code, codeVerifier) {
    const t = await this.#token({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: this.redirectUri,
    });
    // The id_token came straight from Google's token endpoint over TLS, so its claims can be
    // trusted without a signature check (OIDC Core 3.1.3.7); we still validate them.
    const claims = JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString());
    if (claims.aud !== this.clientId || !ISSUERS.includes(claims.iss) || !claims.email_verified) {
      throw new Error('Invalid Google id_token');
    }
    if (!t.scope?.split(' ').includes(GMAIL_SCOPE)) throw new Error('Gmail access was not granted');
    if (!t.refresh_token) throw new Error('Google did not return a refresh token');
    const email = claims.email.toLowerCase();
    this.#accessTokens.set(email, { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 });
    return { email, refreshToken: t.refresh_token };
  }

  async revoke(refreshToken) {
    await fetch(this.endpoints.revokeUrl, { method: 'POST', body: new URLSearchParams({ token: refreshToken }) });
  }

  forget(email) {
    this.#accessTokens.delete(email);
  }

  async gmail(email, method, path, body) {
    const res = await fetch(`${this.endpoints.gmailUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.#accessToken(email)}`, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Gmail API ${res.status}: ${json.error?.message ?? res.statusText}`);
    return json;
  }

  async #accessToken(email) {
    const cached = this.#accessTokens.get(email);
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    const account = this.store.data.accounts[email];
    if (!account) throw new Error(`Account ${email} is not linked`);
    let t;
    try {
      t = await this.#token({ grant_type: 'refresh_token', refresh_token: account.refreshToken });
    } catch (e) {
      if (e.message.includes('invalid_grant')) {
        throw new Error(`Google access for ${email} expired or was revoked; re-link it with link_account`);
      }
      throw e;
    }
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
