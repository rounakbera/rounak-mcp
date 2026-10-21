// Runs the real app against the fake Google server and drives it like claude.ai would.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../../src/app.js';
import { CLAUDE_REDIRECT_URIS } from '../../src/config.js';
import { Google } from '../../src/google.js';
import { linkAccount } from '../../src/link.js';
import { loadModules, scopesFor } from '../../src/modules/index.js';
import { sha256 } from '../../src/oauth.js';
import { Store } from '../../src/store.js';
import { gmailMessage, startFakeGoogle } from './fake-google.js';

export const OWNER = 'owner@example.com';
export const WORK = 'work@example.com';
export const REDIRECT = CLAUDE_REDIRECT_URIS[0];
const GOOGLE = { clientId: 'google-client-id', clientSecret: 'google-client-secret' };
const CLIENT = { id: 'claude-connector', secret: randomBytes(32).toString('base64url') };
const KEY = randomBytes(32);
const MODULES = ['mail', 'calendar', 'maps'];

export const decodeRaw = (raw) => Buffer.from(raw, 'base64url').toString();

export async function startApp(ctx) {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const config = {
    publicUrl: new URL(`http://127.0.0.1:${port}`),
    ownerEmail: OWNER,
    googleClientId: GOOGLE.clientId,
    googleClientSecret: GOOGLE.clientSecret,
    mcpClientId: CLIENT.id,
    mcpClientSecret: CLIENT.secret,
    redirectUris: CLAUDE_REDIRECT_URIS,
    encryptionKey: KEY,
    dataDir: ctx.dataDir,
    modules: MODULES,
    calendarIds: ctx.calendarIds ?? null,
    mapsListIds: ctx.mapsListIds ?? [],
  };
  server.on('request', createApp(config, { googleEndpoints: ctx.google.endpoints }));
  ctx.app = { base: config.publicUrl, port, close: () => (server.closeAllConnections(), server.close()) };
}

// Fresh data dir, fake Google with one seeded thread per account, and a running app.
// `calendarIds` and `mapsListIds` stand in for CALENDAR_IDS and MAPS_LIST_IDS.
export async function setup({ calendarIds, mapsListIds } = {}) {
  const ctx = { dataDir: mkdtempSync(join(tmpdir(), 'rounak-mcp-')), google: await startFakeGoogle(GOOGLE), clients: [], calendarIds, mapsListIds };
  ctx.google.mailbox(OWNER).threads.push({
    id: 't1',
    messages: [gmailMessage({ id: 'm1', threadId: 't1', from: 'Alice <alice@example.com>', subject: 'Your invoice', body: 'invoice attached', snippet: 'invoice attached &amp; it&#39;s &#8212; here' })],
  });
  ctx.google.mailbox(WORK).threads.push({
    id: 'w1',
    messages: [gmailMessage({ id: 'wm1', threadId: 'w1', from: 'bob@corp.example', subject: 'Q3 invoice', body: 'invoice for Q3' })],
  });
  await startApp(ctx);
  ctx.teardown = async () => {
    await Promise.all(ctx.clients.map((c) => c.close()));
    ctx.app.close();
    await ctx.google.close();
    rmSync(ctx.dataDir, { recursive: true, force: true });
  };
  return ctx;
}

// What `npm run link` does, as a separate process would: its own Store and Google client.
export function cli(ctx) {
  const store = new Store(ctx.dataDir, KEY);
  return { store, google: new Google({ ...GOOGLE, endpoints: ctx.google.endpoints, store }) };
}

// `modules` are the ones the account grants scopes for.
export async function link(ctx, email, modules = MODULES) {
  const { url, linked } = await linkAccount({ ...cli(ctx), port: 0, scopes: scopesFor(loadModules(modules)) });
  ctx.google.state.nextLogin = email;
  const toCallback = await fetch(url, { redirect: 'manual' });
  const res = await fetch(toCallback.headers.get('location'));
  return { url, res, linked: await linked.catch((e) => e) };
}

// Drives the browser half of the OAuth flow: /authorize -> Google -> /oauth/google/callback -> claude.ai.
export async function signIn(ctx, email, { redirectUri = REDIRECT } = {}) {
  ctx.google.state.nextLogin = email;
  const verifier = randomBytes(32).toString('base64url');
  const url = new URL('/authorize', ctx.app.base);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT.id,
    redirect_uri: redirectUri,
    code_challenge: sha256(verifier),
    code_challenge_method: 'S256',
    state: 'claude-state',
    resource: new URL('/mcp', ctx.app.base).href,
  });
  let res = await fetch(url, { redirect: 'manual' });
  for (let hop = 0; res.status === 302 && !res.headers.get('location').startsWith(redirectUri); hop++) {
    assert.ok(hop < 3, 'too many redirects');
    res = await fetch(res.headers.get('location'), { redirect: 'manual' });
  }
  return { res, verifier };
}

export async function token(ctx, params, secret = CLIENT.secret) {
  const res = await fetch(new URL('/token', ctx.app.base), {
    method: 'POST',
    body: new URLSearchParams({ client_id: CLIENT.id, client_secret: secret, ...params }),
  });
  return { status: res.status, body: await res.json() };
}

export async function signInAndGetTokens(ctx) {
  const { res, verifier } = await signIn(ctx, OWNER);
  const code = new URL(res.headers.get('location')).searchParams.get('code');
  return (await token(ctx, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT })).body;
}

export async function connect(ctx, accessToken) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', ctx.app.base), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }),
  );
  ctx.clients.push(client);
  return client;
}

export async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
}
