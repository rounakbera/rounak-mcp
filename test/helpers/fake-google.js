// A real HTTP server standing in for Google OAuth, the Gmail and Calendar APIs, and shared Maps lists. The only mock in the test suite.
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
        { mimeType: 'application/pdf', filename: 'invoice.pdf', body: { attachmentId: 'a1', size: 11 } },
      ],
    },
  };
}

// A shared Google Maps list as its endpoint returns it, owner details included. `cid` is signed, as Google sends it.
export function mapsList(id, name, places) {
  const owner = ['List Owner', 'https://example.com/avatar.png', '100000000000000000001'];
  const items = places.map(({ name: n, note = '', address = '', lat, lng, cid }) => [
    null,
    [null, null, address && `${n}, ${address}`, null, address, [null, null, lat, lng], ['-1', cid]],
    n, note, null, null, null, [], [[1], ['-1', cid]], [1792531684, 0], [1792531684, 0], null, owner,
  ]);
  return `)]}'\n${JSON.stringify([[[id, 1, [[1], [9]], 1, 1], 4, [2, 1, `https://www.google.com/maps/placelists/list/${id}`], owner, name, '', null, null, items]])}`;
}

export async function startFakeGoogle({ clientId, clientSecret }) {
  const state = {
    nextLogin: null, // email the next sign-in succeeds as
    mailboxes: new Map(), // email -> { threads, sent, drafts }
    calendars: new Map(), // email -> { calendars, events: { calendarId: [event] }, writes }
    codes: new Map(),
    accessTokens: new Map(), // token -> email
    refreshTokens: new Map(), // token -> email
    refreshGrants: 0,
    mapsLists: new Map(), // list ID -> raw response body
  };
  const mailbox = (email) => {
    if (!state.mailboxes.has(email)) state.mailboxes.set(email, { threads: [], sent: [], drafts: [] });
    return state.mailboxes.get(email);
  };
  const calendar = (email) => {
    if (!state.calendars.has(email)) state.calendars.set(email, { calendars: [], events: {}, writes: [] });
    return state.calendars.get(email);
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
    'GET /maps/preview/entitylist/getlist': ({ query }) => {
      const body = state.mapsLists.get(query.get('pb')?.match(/^!1m4!1s([^!]+)!/)?.[1]);
      return body === undefined ? [404, {}] : [200, body];
    },
    'POST /revoke': ({ form }) => {
      state.refreshTokens.delete(form.get('token'));
      return [200, {}];
    },
  };

  const NOT_FOUND = [404, { error: { message: 'Not Found' } }];
  const gmailRoutes = [
    ['GET', /^\/threads$/, (box, _m, { query }) => [200, { threads: box.threads.filter((t) => t.messages.some((x) => x.snippet.includes(query.get('q')))).map(({ id }) => ({ id })) }]],
    ['GET', /^\/threads\/([^/]+)$/, (box, m) => box.threads.find((t) => t.id === m[1])],
    ['GET', /^\/messages\/([^/]+)\/attachments\/([^/]+)$/, (_box, m) => [200, { size: 11, data: b64url(`%PDF-${m[2]}`.padEnd(11, '.')) }]],
    ['GET', /^\/messages\/([^/]+)$/, (box, m) => box.threads.flatMap((t) => t.messages).find((x) => x.id === m[1])],
    ['GET', /^\/labels$/, () => [200, { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'Label_1', name: 'Receipts', type: 'user' }] }]],
    ['POST', /^\/messages\/send$/, (box, _m, { json }) => (box.sent.push(json), [200, { id: `sent-${box.sent.length}`, threadId: json.threadId }])],
    ['POST', /^\/drafts$/, (box, _m, { json }) => {
      const d = { id: `draft-${box.drafts.length + 1}`, message: { id: `dm-${box.drafts.length + 1}`, ...json.message } };
      box.drafts.push(d);
      return d;
    }],
    ['GET', /^\/drafts$/, (box) => [200, { drafts: box.drafts.map(({ id, message }) => ({ id, message: { id: message.id, threadId: message.threadId } })) }]],
    ['POST', /^\/drafts\/send$/, (box, _m, { json }) => {
      const d = box.drafts.find((x) => x.id === json.id);
      if (!d) return NOT_FOUND;
      box.drafts.splice(box.drafts.indexOf(d), 1);
      box.sent.push(d.message);
      return [200, { id: `sent-${box.sent.length}`, threadId: d.message.threadId }];
    }],
    // Drafts are stored as the API takes them (`raw`) or as seeded (`payload`); updates replace the message.
    ['GET', /^\/drafts\/([^/]+)$/, (box, m) => box.drafts.find((x) => x.id === m[1]) ?? NOT_FOUND],
    ['PUT', /^\/drafts\/([^/]+)$/, (box, m, { json }) => {
      const d = box.drafts.find((x) => x.id === m[1]);
      if (!d) return NOT_FOUND;
      d.message = { id: `${d.message.id}-v2`, ...json.message };
      return d;
    }],
    ['DELETE', /^\/drafts\/([^/]+)$/, (box, m) => {
      const d = box.drafts.find((x) => x.id === m[1]);
      if (!d) return NOT_FOUND;
      box.drafts.splice(box.drafts.indexOf(d), 1);
      return [204, ''];
    }],
    ['POST', /^\/threads\/([^/]+)\/(modify|trash)$/, (box, m, { json }) => {
      const t = box.threads.find((x) => x.id === m[1]);
      const [add, remove] = m[2] === 'trash' ? [['TRASH'], ['INBOX']] : [json.addLabelIds, json.removeLabelIds];
      for (const msg of t?.messages ?? []) msg.labelIds = [...new Set([...msg.labelIds.filter((l) => !remove.includes(l)), ...add])];
      return t;
    }],
  ];

  // Calendar: `primary` aliases the primary calendar; unknown calendars and events are 404s.
  const calOf = (acct, id) => acct.calendars.find((c) => c.id === decodeURIComponent(id) || (c.primary && id === 'primary'));
  const eventsOf = (acct, id) => {
    const c = calOf(acct, id);
    return c && (acct.events[c.id] ??= []);
  };
  const ms = (t) => Date.parse(t.dateTime ?? t.date);
  const withEvent = (fn) => (acct, m, ctx) => {
    const list = eventsOf(acct, m[1]);
    const e = list?.find((x) => x.id === decodeURIComponent(m[2]));
    return e ? fn(e, list, acct, ctx) : NOT_FOUND;
  };
  const logWrite = (acct, method, { query, json }) => acct.writes.push({ method, query: Object.fromEntries(query), json });
  const calendarRoutes = [
    ['GET', /^\/users\/me\/calendarList$/, (acct) => [200, { items: acct.calendars }]],
    ['GET', /^\/calendars\/([^/]+)\/events$/, (acct, m, { query }) => {
      const list = eventsOf(acct, m[1]);
      if (!list) return NOT_FOUND;
      const [min, max, q] = [Date.parse(query.get('timeMin')), Date.parse(query.get('timeMax')), query.get('q')];
      const items = list
        .filter((e) => ms(e.end) > min && ms(e.start) < max && (!q || e.summary.includes(q)))
        .sort((a, b) => ms(a.start) - ms(b.start))
        .slice(0, Number(query.get('maxResults')));
      return [200, { items, timeZone: calOf(acct, m[1]).timeZone }];
    }],
    ['GET', /^\/calendars\/([^/]+)\/events\/([^/]+)$/, withEvent((e) => e)],
    ['POST', /^\/calendars\/([^/]+)\/events$/, (acct, m, ctx) => {
      const list = eventsOf(acct, m[1]);
      if (!list) return NOT_FOUND;
      logWrite(acct, 'POST', ctx);
      const e = { id: `ev-${randomUUID()}`, status: 'confirmed', ...ctx.json, ...(ctx.json.conferenceData && { hangoutLink: 'https://meet.google.com/abc-defg-hij' }) };
      list.push(e);
      return e;
    }],
    ['PATCH', /^\/calendars\/([^/]+)\/events\/([^/]+)$/, withEvent((e, _list, acct, ctx) => {
      logWrite(acct, 'PATCH', ctx);
      // With attendeesOmitted, the attendees sent are merged into the list by email.
      const { attendeesOmitted, ...patch } = ctx.json;
      if (attendeesOmitted) {
        patch.attendees = (e.attendees ?? []).map((a) => ({ ...a, ...patch.attendees.find((p) => p.email === a.email) }));
      }
      return Object.assign(e, patch);
    })],
    ['DELETE', /^\/calendars\/([^/]+)\/events\/([^/]+)$/, withEvent((e, list, acct, ctx) => {
      logWrite(acct, 'DELETE', ctx);
      list.splice(list.indexOf(e), 1);
      return [200, {}];
    })],
    ['POST', /^\/freeBusy$/, (acct, _m, { json }) => {
      const [min, max] = [Date.parse(json.timeMin), Date.parse(json.timeMax)];
      const calendars = Object.fromEntries(
        json.items.map(({ id }) => {
          const list = eventsOf(acct, id);
          if (!list) return [id, { errors: [{ domain: 'global', reason: 'notFound' }] }];
          const busy = list
            .filter((e) => ms(e.end) > min && ms(e.start) < max)
            .map((e) => ({ start: new Date(Math.max(ms(e.start), min)).toISOString(), end: new Date(Math.min(ms(e.end), max)).toISOString() }));
          return [id, { busy }];
        }),
      );
      return [200, { calendars }];
    }],
  ];
  const apis = [
    [/^\/gmail\/v1\/users\/me(\/.*)$/, gmailRoutes, mailbox],
    [/^\/calendar\/v3(\/.*)$/, calendarRoutes, calendar],
  ];

  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://x');
    const ctx = { query: url.searchParams, form: new URLSearchParams(body), json: body && req.headers['content-type'] === 'application/json' ? JSON.parse(body) : {} };

    let result = routes[`${req.method} ${url.pathname}`]?.(ctx);
    for (const [prefix, apiRoutes, data] of apis) {
      const path = url.pathname.match(prefix)?.[1];
      if (!path) continue;
      const email = state.accessTokens.get(req.headers.authorization?.replace('Bearer ', ''));
      for (const [method, re, handler] of apiRoutes) {
        const m = req.method === method && path.match(re);
        if (!m) continue;
        result = email ? handler(data(email), m, ctx) : [401, { error: { message: 'Invalid Credentials' } }];
        break;
      }
      if (result && !Array.isArray(result)) result = [200, result];
    }
    const [status, payload] = result ?? [404, { error: { message: 'Not Found' } }];
    if (status === 302) return res.writeHead(302, { location: payload }).end();
    if (typeof payload === 'string') return res.writeHead(status, { 'content-type': 'application/json' }).end(payload);
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    mailbox,
    calendar,
    endpoints: {
      authUrl: `${base}/auth`,
      tokenUrl: `${base}/token`,
      revokeUrl: `${base}/revoke`,
      gmail: `${base}/gmail/v1/users/me`,
      calendar: `${base}/calendar/v3`,
      maps: `${base}/maps/preview/entitylist/getlist`,
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
