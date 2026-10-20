// A real HTTP server standing in for Google OAuth + the Gmail API. The only mock in the test suite.
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const b64url = (s) => Buffer.from(s).toString('base64url');

export function gmailMessage({ id, threadId, from, subject, body, messageId = `<${id}@example.com>` }) {
  return {
    id,
    threadId,
    labelIds: ['INBOX', 'UNREAD'],
    snippet: body.slice(0, 50),
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: subject },
        { name: 'Date', value: 'Mon, 19 Oct 2026 10:00:00 +0000' },
        { name: 'Message-ID', value: messageId },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: b64url(body) } },
        { mimeType: 'text/html', body: { data: b64url(`<p>${body}</p>`) } },
        { mimeType: 'application/pdf', filename: 'invoice.pdf', body: { attachmentId: 'a1' } },
      ],
    },
  };
}

export async function startFakeGoogle({ clientId, clientSecret }) {
  const state = {
    nextLogin: null, // email the next "Google sign-in" succeeds as
    mailboxes: new Map(), // email -> { threads: [{ id, messages }], sent: [], drafts: [] }
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

  async function readBody(req) {
    let data = '';
    for await (const chunk of req) data += chunk;
    return data;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };

    if (req.method === 'GET' && url.pathname === '/auth') {
      const q = url.searchParams;
      if (q.get('client_id') !== clientId || q.get('code_challenge_method') !== 'S256') return send(400, {});
      const code = `code-${randomUUID()}`;
      state.codes.set(code, { email: state.nextLogin, challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri') });
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state'));
      return res.writeHead(302, { location: back.href }).end();
    }

    if (req.method === 'POST' && url.pathname === '/token') {
      const p = new URLSearchParams(await readBody(req));
      if (p.get('client_id') !== clientId || p.get('client_secret') !== clientSecret) {
        return send(401, { error: 'invalid_client' });
      }
      if (p.get('grant_type') === 'authorization_code') {
        const c = state.codes.get(p.get('code'));
        state.codes.delete(p.get('code'));
        const challenge = createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url');
        if (!c || c.challenge !== challenge || c.redirectUri !== p.get('redirect_uri')) {
          return send(400, { error: 'invalid_grant' });
        }
        const refresh = `rt-${randomUUID()}`;
        state.refreshTokens.set(refresh, c.email);
        const claims = { iss: 'https://accounts.google.com', aud: clientId, email: c.email, email_verified: true };
        return send(200, {
          access_token: issueAccess(c.email),
          refresh_token: refresh,
          expires_in: 3599,
          scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.modify',
          id_token: `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(claims))}.sig`,
        });
      }
      if (p.get('grant_type') === 'refresh_token') {
        state.refreshGrants++;
        const email = state.refreshTokens.get(p.get('refresh_token'));
        if (!email) return send(400, { error: 'invalid_grant' });
        return send(200, { access_token: issueAccess(email), expires_in: 3599 });
      }
      return send(400, { error: 'unsupported_grant_type' });
    }

    if (req.method === 'POST' && url.pathname === '/revoke') {
      state.refreshTokens.delete(new URLSearchParams(await readBody(req)).get('token'));
      return send(200, {});
    }

    const gmail = url.pathname.match(/^\/gmail\/v1\/users\/me(\/.*)$/);
    if (gmail) {
      const email = state.accessTokens.get(req.headers.authorization?.replace('Bearer ', ''));
      if (!email) return send(401, { error: { message: 'Invalid Credentials' } });
      const box = mailbox(email);
      const path = gmail[1];
      const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : undefined;
      const thread = (id) => box.threads.find((t) => t.id === id);
      let m;

      if (req.method === 'GET' && path === '/threads') {
        const q = url.searchParams.get('q');
        const hits = box.threads.filter((t) => t.messages.some((msg) => msg.snippet.includes(q)));
        return send(200, { threads: hits.slice(0, Number(url.searchParams.get('maxResults'))).map(({ id }) => ({ id })) });
      }
      if (req.method === 'GET' && (m = path.match(/^\/threads\/([^/]+)$/))) {
        return thread(m[1]) ? send(200, thread(m[1])) : send(404, { error: { message: 'Not Found' } });
      }
      if (req.method === 'GET' && (m = path.match(/^\/messages\/([^/]+)$/))) {
        const msg = box.threads.flatMap((t) => t.messages).find((x) => x.id === m[1]);
        return msg ? send(200, msg) : send(404, { error: { message: 'Not Found' } });
      }
      if (req.method === 'POST' && path === '/messages/send') {
        box.sent.push(body);
        return send(200, { id: `sent-${box.sent.length}`, threadId: body.threadId ?? `new-${box.sent.length}` });
      }
      if (req.method === 'POST' && path === '/drafts') {
        box.drafts.push(body);
        return send(200, { id: `draft-${box.drafts.length}`, message: { threadId: body.message.threadId } });
      }
      if (req.method === 'POST' && (m = path.match(/^\/threads\/([^/]+)\/(modify|trash)$/))) {
        const t = thread(m[1]);
        if (!t) return send(404, { error: { message: 'Not Found' } });
        const [add, remove] = m[2] === 'trash' ? [['TRASH'], ['INBOX']] : [body.addLabelIds, body.removeLabelIds];
        for (const msg of t.messages) {
          msg.labelIds = [...new Set([...msg.labelIds.filter((l) => !remove.includes(l)), ...add])];
        }
        return send(200, t);
      }
      if (req.method === 'GET' && path === '/labels') {
        return send(200, { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'Label_1', name: 'Receipts', type: 'user' }] });
      }
    }
    send(404, {});
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    mailbox,
    endpoints: {
      authUrl: `${base}/auth`,
      tokenUrl: `${base}/token`,
      revokeUrl: `${base}/revoke`,
      gmailUrl: `${base}/gmail/v1/users/me`,
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
