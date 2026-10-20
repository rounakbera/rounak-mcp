// A real HTTP server standing in for Google OAuth + the Gmail API. The only mock in the test suite.
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const b64url = (s) => Buffer.from(s).toString('base64url');

export function gmailMessage({ id, threadId, from, subject, body, snippet = body }) {
  const headers = { From: from, Subject: subject, Date: 'Mon, 19 Oct 2026 10:00:00 +0000', 'Message-ID': `<${id}@example.com>` };
  return {
    id,
    threadId,
    labelIds: ['INBOX', 'UNREAD'],
    snippet,
    payload: {
      mimeType: 'multipart/mixed',
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      parts: [
        { mimeType: 'text/plain', body: { data: b64url(body) } },
        { mimeType: 'application/pdf', filename: 'invoice.pdf', body: { attachmentId: 'a1' } },
      ],
    },
  };
}

export async function startFakeGoogle({ clientId, clientSecret }) {
  const state = {
    nextLogin: null, // email the next sign-in succeeds as
    mailboxes: new Map(), // email -> { threads, sent, drafts }
    codes: new Map(),
    accessTokens: new Map(), // token -> email
    refreshTokens: new Map(), // token -> email
    refreshGrants: 0,
  };
  const mailbox = (email) => {
    if (!state.mailboxes.has(email)) state.mailboxes.set(email, { threads: [], sent: [], drafts: [] });
    return state.mailboxes.get(email);
  };
  const issueAccess = (email) => {
    const token = `at-${randomUUID()}`;
    state.accessTokens.set(token, email);
    return token;
  };

  const routes = {
    'GET /auth': ({ query }) => {
      if (query.get('client_id') !== clientId || query.get('code_challenge_method') !== 'S256') return [400, {}];
      const code = `code-${randomUUID()}`;
      state.codes.set(code, { email: state.nextLogin, scope: query.get('scope'), offline: query.get('access_type') === 'offline', challenge: query.get('code_challenge'), redirectUri: query.get('redirect_uri') });
      const back = new URL(query.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', query.get('state'));
      return [302, back.href];
    },
    'POST /token': ({ form }) => {
      if (form.get('client_id') !== clientId || form.get('client_secret') !== clientSecret) return [401, { error: 'invalid_client' }];
      if (form.get('grant_type') === 'refresh_token') {
        state.refreshGrants++;
        const email = state.refreshTokens.get(form.get('refresh_token'));
        return email ? [200, { access_token: issueAccess(email), expires_in: 3599 }] : [400, { error: 'invalid_grant' }];
      }
      const c = state.codes.get(form.get('code'));
      state.codes.delete(form.get('code'));
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (!c || c.challenge !== challenge || c.redirectUri !== form.get('redirect_uri')) return [400, { error: 'invalid_grant' }];
      const claims = { iss: 'https://accounts.google.com', aud: clientId, email: c.email, email_verified: true };
      const refresh = c.offline && `rt-${randomUUID()}`;
      if (refresh) state.refreshTokens.set(refresh, c.email);
      return [200, { access_token: issueAccess(c.email), expires_in: 3599, scope: c.scope, id_token: `e30.${b64url(JSON.stringify(claims))}.sig`, ...(refresh && { refresh_token: refresh }) }];
    },
    'POST /revoke': ({ form }) => {
      state.refreshTokens.delete(form.get('token'));
      return [200, {}];
    },
  };

  const gmailRoutes = [
    ['GET', /^\/threads$/, (box, _m, { query }) => [200, { threads: box.threads.filter((t) => t.messages.some((x) => x.snippet.includes(query.get('q')))).map(({ id }) => ({ id })) }]],
    ['GET', /^\/threads\/([^/]+)$/, (box, m) => box.threads.find((t) => t.id === m[1])],
    ['GET', /^\/messages\/([^/]+)$/, (box, m) => box.threads.flatMap((t) => t.messages).find((x) => x.id === m[1])],
    ['GET', /^\/labels$/, () => [200, { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'Label_1', name: 'Receipts', type: 'user' }] }]],
    ['POST', /^\/messages\/send$/, (box, _m, { json }) => (box.sent.push(json), [200, { id: `sent-${box.sent.length}`, threadId: json.threadId }])],
    ['POST', /^\/drafts$/, (box, _m, { json }) => (box.drafts.push(json), [200, { id: `draft-${box.drafts.length}`, message: json.message }])],
    ['POST', /^\/threads\/([^/]+)\/(modify|trash)$/, (box, m, { json }) => {
      const t = box.threads.find((x) => x.id === m[1]);
      const [add, remove] = m[2] === 'trash' ? [['TRASH'], ['INBOX']] : [json.addLabelIds, json.removeLabelIds];
      for (const msg of t?.messages ?? []) msg.labelIds = [...new Set([...msg.labelIds.filter((l) => !remove.includes(l)), ...add])];
      return t;
    }],
  ];

  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://x');
    const ctx = { query: url.searchParams, form: new URLSearchParams(body), json: body && req.headers['content-type'] === 'application/json' ? JSON.parse(body) : {} };

    let result = routes[`${req.method} ${url.pathname}`]?.(ctx);
    const gmailPath = url.pathname.match(/^\/gmail\/v1\/users\/me(\/.*)$/)?.[1];
    if (gmailPath) {
      const email = state.accessTokens.get(req.headers.authorization?.replace('Bearer ', ''));
      for (const [method, re, handler] of gmailRoutes) {
        const m = req.method === method && gmailPath.match(re);
        if (!m) continue;
        result = email ? handler(mailbox(email), m, ctx) : [401, { error: { message: 'Invalid Credentials' } }];
        break;
      }
      if (result && !Array.isArray(result)) result = [200, result];
    }
    const [status, payload] = result ?? [404, { error: { message: 'Not Found' } }];
    if (status === 302) return res.writeHead(302, { location: payload }).end();
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    mailbox,
    endpoints: { authUrl: `${base}/auth`, tokenUrl: `${base}/token`, revokeUrl: `${base}/revoke`, gmail: `${base}/gmail/v1/users/me` },
    close: () => new Promise((r) => server.close(r)),
  };
}
