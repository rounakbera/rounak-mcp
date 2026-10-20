import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { CLAUDE_REDIRECT_URIS } from '../src/config.js';
import { gmailMessage, startFakeGoogle } from './fake-google.js';

const OWNER = 'owner@example.com';
const WORK = 'work@example.com';
const GOOGLE = { clientId: 'google-client-id', clientSecret: 'google-client-secret' };
const CLIENT = { id: 'claude-connector', secret: randomBytes(32).toString('base64url') };
const REDIRECT = CLAUDE_REDIRECT_URIS[0];
const KEY = randomBytes(32);

const sha256 = (s) => createHash('sha256').update(s).digest('base64url');
const basic = (id, secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
const decodeRaw = (raw) => Buffer.from(raw, 'base64url').toString();

async function startApp(dataDir, google) {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const publicUrl = new URL(`http://127.0.0.1:${server.address().port}`);
  const config = {
    publicUrl,
    ownerEmail: OWNER,
    googleClientId: GOOGLE.clientId,
    googleClientSecret: GOOGLE.clientSecret,
    mcpClientId: CLIENT.id,
    mcpClientSecret: CLIENT.secret,
    redirectUris: CLAUDE_REDIRECT_URIS,
    encryptionKey: KEY,
    dataDir,
  };
  server.on('request', createApp(config, { googleEndpoints: google.endpoints }));
  return { base: publicUrl, port: server.address().port, close: () => server.closeAllConnections() || server.close() };
}

// Drives the browser half of the OAuth flow: our /authorize -> Google -> our callback -> claude.ai redirect.
async function signIn(base, google, email, { redirectUri = REDIRECT } = {}) {
  google.state.nextLogin = email;
  const verifier = randomBytes(32).toString('base64url');
  const url = new URL('/authorize', base);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT.id,
    redirect_uri: redirectUri,
    code_challenge: sha256(verifier),
    code_challenge_method: 'S256',
    state: 'claude-state',
    resource: new URL('/mcp', base).href,
  });
  let res = await fetch(url, { redirect: 'manual' });
  for (let hop = 0; res.status === 302 && !res.headers.get('location').startsWith(redirectUri); hop++) {
    assert.ok(hop < 3, 'too many redirects');
    res = await fetch(res.headers.get('location'), { redirect: 'manual' });
  }
  return { res, verifier };
}

async function token(base, params, secret = CLIENT.secret) {
  const res = await fetch(new URL('/token', base), {
    method: 'POST',
    headers: { authorization: basic(CLIENT.id, secret), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  return { status: res.status, body: await res.json() };
}

async function signInAndGetTokens(base, google) {
  const { res, verifier } = await signIn(base, google, OWNER);
  const code = new URL(res.headers.get('location')).searchParams.get('code');
  const { body } = await token(base, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT });
  return body;
}

async function connect(base, accessToken) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', base), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }),
  );
  return client;
}

async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
}

describe('gmail-mcp', () => {
  let google, app, dataDir, tokens, client;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'gmail-mcp-'));
    google = await startFakeGoogle(GOOGLE);
    app = await startApp(dataDir, google);
    google.mailbox(OWNER).threads.push({
      id: 't1',
      messages: [gmailMessage({ id: 'm1', threadId: 't1', from: 'Alice <alice@example.com>', subject: 'Your invoice', body: 'invoice attached' })],
    });
    google.mailbox(WORK).threads.push({
      id: 'w1',
      messages: [gmailMessage({ id: 'wm1', threadId: 'w1', from: 'bob@corp.com', subject: 'Q3 invoice', body: 'invoice for Q3' })],
    });
  });

  after(async () => {
    await client?.close();
    app.close();
    await google.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('rejects requests for any host other than the public one', async () => {
    const status = await new Promise((resolve) => {
      get({ host: '127.0.0.1', port: app.port, path: '/.well-known/oauth-authorization-server', headers: { host: 'evil.example' } }, (res) =>
        resolve(res.statusCode),
      );
    });
    assert.equal(status, 421);
  });

  test('MCP endpoint requires a valid bearer token', async () => {
    const res = await fetch(new URL('/mcp', app.base), { method: 'POST' });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate'), /resource_metadata=".*\/\.well-known\/oauth-protected-resource\/mcp"/);
    const bogus = await fetch(new URL('/mcp', app.base), { method: 'POST', headers: { authorization: 'Bearer nope' } });
    assert.equal(bogus.status, 401);
  });

  test('advertises OAuth metadata without dynamic client registration', async () => {
    const meta = await (await fetch(new URL('/.well-known/oauth-authorization-server', app.base))).json();
    assert.equal(meta.registration_endpoint, undefined);
    assert.equal((await fetch(new URL('/register', app.base), { method: 'POST' })).status, 404);
  });

  test('rejects unregistered redirect URIs', async () => {
    const { res } = await signIn(app.base, google, OWNER, { redirectUri: 'https://evil.example/callback' });
    assert.equal(res.status, 400);
  });

  test('refuses Google accounts other than the owner and revokes their grant', async () => {
    const { res } = await signIn(app.base, google, 'stranger@example.com');
    assert.equal(res.status, 403);
    assert.ok(![...google.state.refreshTokens.values()].includes('stranger@example.com'));
  });

  test('owner signs in; PKCE and client secret are enforced', async () => {
    const { res, verifier } = await signIn(app.base, google, OWNER);
    const redirect = new URL(res.headers.get('location'));
    assert.equal(redirect.searchParams.get('state'), 'claude-state');
    const code = redirect.searchParams.get('code');
    const grant = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT };

    assert.equal((await token(app.base, { ...grant, code_verifier: 'wrong'.repeat(10) })).status, 400);
    assert.equal((await token(app.base, { ...grant, code_verifier: verifier }, 'wrong-secret')).status, 400);
    const ok = await token(app.base, { ...grant, code_verifier: verifier });
    assert.equal(ok.status, 200);
    assert.equal((await token(app.base, { ...grant, code_verifier: verifier })).status, 400, 'codes are single-use');

    tokens = ok.body;
    client = await connect(app.base, tokens.access_token);
    assert.deepEqual((await call(client, 'list_accounts')).map((a) => a.email), [OWNER]);
  });

  test('links a second account and searches across both', async () => {
    const { url } = await call(client, 'link_account');
    google.state.nextLogin = WORK;
    const toCallback = await fetch(url, { redirect: 'manual' });
    const linked = await fetch(toCallback.headers.get('location'), { redirect: 'manual' });
    assert.equal(linked.status, 200);
    assert.match(await linked.text(), /Linked work@example\.com/);

    const results = await call(client, 'search_threads', { query: 'invoice' });
    assert.deepEqual(results.map((r) => [r.account, r.thread_id, r.subject]).sort(), [
      [OWNER, 't1', 'Your invoice'],
      [WORK, 'w1', 'Q3 invoice'],
    ]);
    const workOnly = await call(client, 'search_threads', { query: 'invoice', account: WORK });
    assert.deepEqual(workOnly.map((r) => r.thread_id), ['w1']);
  });

  test('reads a thread', async () => {
    const [msg] = await call(client, 'get_thread', { account: OWNER, thread_id: 't1' });
    assert.equal(msg.body, 'invoice attached');
    assert.deepEqual(msg.attachments, ['invoice.pdf']);
  });

  test('requires an account when several are linked', async () => {
    await assert.rejects(call(client, 'list_labels'), /Specify an account/);
    await assert.rejects(call(client, 'list_labels', { account: 'nobody@example.com' }), /Unknown account/);
  });

  test('replies in-thread with correct headers', async () => {
    const sent = await call(client, 'send_email', { account: OWNER, reply_to_message_id: 'm1', body: 'Thanks!' });
    assert.equal(sent.thread_id, 't1');
    const [{ raw, threadId }] = google.mailbox(OWNER).sent;
    const mime = decodeRaw(raw);
    assert.equal(threadId, 't1');
    assert.match(mime, /^To: Alice <alice@example\.com>\r$/m);
    assert.match(mime, /^Subject: Re: Your invoice\r$/m);
    assert.match(mime, /^In-Reply-To: <m1@example\.com>\r$/m);
    assert.match(mime, /^References: <m1@example\.com>\r$/m);
    assert.equal(Buffer.from(mime.split('\r\n\r\n')[1], 'base64').toString(), 'Thanks!');
  });

  test('rejects header injection', async () => {
    await assert.rejects(
      call(client, 'send_email', { account: OWNER, to: 'a@example.com', subject: 'hi\r\nBcc: spy@evil.example', body: 'x' }),
      /line breaks/,
    );
    assert.equal(google.mailbox(OWNER).sent.length, 1);
  });

  test('creates a draft with a UTF-8 subject', async () => {
    await call(client, 'create_draft', { account: WORK, to: 'bob@corp.com', subject: 'Café ☕', body: 'draft' });
    const mime = decodeRaw(google.mailbox(WORK).drafts[0].message.raw);
    assert.match(mime, new RegExp(`^Subject: =\\?UTF-8\\?B\\?${Buffer.from('Café ☕').toString('base64')}\\?=\\r$`, 'm'));
  });

  test('lists labels, modifies and trashes threads', async () => {
    const labels = await call(client, 'list_labels', { account: OWNER });
    assert.ok(labels.some((l) => l.name === 'Receipts'));
    await call(client, 'modify_thread', { account: OWNER, thread_id: 't1', add_labels: ['STARRED'], remove_labels: ['UNREAD'] });
    assert.deepEqual(google.mailbox(OWNER).threads[0].messages[0].labelIds, ['INBOX', 'STARRED']);
    await call(client, 'trash_thread', { account: WORK, thread_id: 'w1' });
    assert.deepEqual(google.mailbox(WORK).threads[0].messages[0].labelIds, ['UNREAD', 'TRASH']);
  });

  test('unlinks an account and revokes it at Google', async () => {
    await call(client, 'unlink_account', { account: WORK });
    assert.deepEqual((await call(client, 'list_accounts')).map((a) => a.email), [OWNER]);
    assert.ok(![...google.state.refreshTokens.values()].includes(WORK));
  });

  test('refresh tokens rotate and cannot be reused', async () => {
    const grant = { grant_type: 'refresh_token', refresh_token: tokens.refresh_token };
    const first = await token(app.base, grant);
    assert.equal(first.status, 200);
    assert.notEqual(first.body.refresh_token, tokens.refresh_token);
    assert.equal((await token(app.base, grant)).status, 400);
    tokens = first.body;
  });

  test('state is encrypted at rest and survives a restart', async () => {
    const file = readFileSync(join(dataDir, 'state.enc'));
    for (const secret of [OWNER, 'rt-', tokens.refresh_token]) assert.ok(!file.includes(secret), `${secret} leaked`);

    await client.close();
    app.close();
    app = await startApp(dataDir, google);
    // Access tokens live in memory only; the client has to refresh.
    const stale = await fetch(new URL('/mcp', app.base), { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}` } });
    assert.equal(stale.status, 401);

    const refreshed = await token(app.base, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    assert.equal(refreshed.status, 200);
    client = await connect(app.base, refreshed.body.access_token);
    const grantsBefore = google.state.refreshGrants;
    assert.equal((await call(client, 'search_threads', { query: 'invoice' })).length, 1);
    assert.equal(google.state.refreshGrants, grantsBefore + 1, 'Google access token refreshed from stored refresh token');
  });
});
