import assert from 'node:assert/strict';
import { get } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { call, connect, OWNER, REDIRECT, setup, signIn, signInAndGetTokens, token } from './helpers/harness.js';

describe('security', () => {
  let ctx;
  before(async () => (ctx = await setup()));
  after(() => ctx.teardown());

  test('rejects requests for any host other than the public one', async () => {
    const status = await new Promise((resolve) => {
      const path = '/.well-known/oauth-authorization-server';
      get({ host: '127.0.0.1', port: ctx.app.port, path, headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode));
    });
    assert.equal(status, 421);
  });

  test('MCP endpoint requires a valid bearer token', async () => {
    const res = await fetch(new URL('/mcp', ctx.app.base), { method: 'POST' });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate'), /resource_metadata=".*\/\.well-known\/oauth-protected-resource\/mcp"/);
    const bogus = await fetch(new URL('/mcp', ctx.app.base), { method: 'POST', headers: { authorization: 'Bearer nope' } });
    assert.equal(bogus.status, 401);
  });

  test('has no dynamic client registration', async () => {
    const meta = await (await fetch(new URL('/.well-known/oauth-authorization-server', ctx.app.base))).json();
    assert.equal(meta.registration_endpoint, undefined);
    assert.equal((await fetch(new URL('/register', ctx.app.base), { method: 'POST' })).status, 404);
  });

  test('rejects unregistered redirect URIs', async () => {
    const { res } = await signIn(ctx, OWNER, { redirectUri: 'https://evil.example/callback' });
    assert.equal(res.status, 400);
  });

  test('sign-in asks Google for identity only, not Gmail access', async () => {
    const res = await fetch(new URL(`/authorize?${new URLSearchParams({ response_type: 'code', client_id: 'claude-connector', redirect_uri: REDIRECT, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' })}`, ctx.app.base), { redirect: 'manual' });
    const google = new URL(res.headers.get('location'));
    assert.equal(google.searchParams.get('scope'), 'openid email');
    assert.equal(google.searchParams.get('access_type'), null);
  });

  test('refuses Google accounts other than the owner', async () => {
    const { res } = await signIn(ctx, 'stranger@example.com');
    assert.equal(res.status, 403);
  });

  test('enforces PKCE, the client secret and single-use codes', async () => {
    const { res, verifier } = await signIn(ctx, OWNER);
    const redirect = new URL(res.headers.get('location'));
    assert.equal(redirect.searchParams.get('state'), 'claude-state');
    const grant = { grant_type: 'authorization_code', code: redirect.searchParams.get('code'), redirect_uri: REDIRECT };

    assert.equal((await token(ctx, { ...grant, code_verifier: 'wrong'.repeat(10) })).status, 400);
    assert.equal((await token(ctx, { ...grant, code_verifier: verifier }, 'wrong-secret')).status, 400);
    const ok = await token(ctx, { ...grant, code_verifier: verifier });
    assert.equal(ok.status, 200);
    assert.equal((await token(ctx, { ...grant, code_verifier: verifier })).status, 400);
    assert.deepEqual(await call(await connect(ctx, ok.body.access_token), 'list_accounts'), []);
  });

  test('refresh tokens rotate and cannot be reused', async () => {
    const tokens = await signInAndGetTokens(ctx);
    const grant = { grant_type: 'refresh_token', refresh_token: tokens.refresh_token };
    const first = await token(ctx, grant);
    assert.equal(first.status, 200);
    assert.notEqual(first.body.refresh_token, tokens.refresh_token);
    assert.equal((await token(ctx, grant)).status, 400);
  });
});

describe('maps security', () => {
  let ctx, client;
  before(async () => {
    ctx = await setup({ mapsListIds: ['huge-list', 'changed-list'] });
    ctx.google.state.mapsLists.set('huge-list', `)]}'\n[${' '.repeat(11_000_000)}]`);
    ctx.google.state.mapsLists.set('changed-list', `)]}'\n[{"places":[]}]`);
    client = await connect(ctx, (await signInAndGetTokens(ctx)).access_token);
  });
  after(() => ctx.teardown());

  test('only accepts list IDs that cannot change the request', () => {
    const env = {
      PUBLIC_URL: 'https://mcp.example.com',
      OWNER_EMAIL: OWNER,
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      MCP_CLIENT_ID: 'id',
      MCP_CLIENT_SECRET: 'x'.repeat(32),
      ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
      MODULES: 'maps',
    };
    assert.deepEqual(loadConfig({ ...env, MAPS_LIST_IDS: 'abc_1-X, def' }).mapsListIds, ['abc_1-X', 'def']);
    for (const ids of ['abc!2e9', 'abc&x=1', '../x']) {
      assert.throws(() => loadConfig({ ...env, MAPS_LIST_IDS: ids }), /MAPS_LIST_IDS must be/);
    }
    assert.throws(() => loadConfig(env), /needs MAPS_LIST_IDS/);
  });

  test('refuses oversized responses and fails loudly when the format changes', async () => {
    await assert.rejects(call(client, 'maps_search_saved', { lists: ['huge-list'] }), /huge-list: response too large/);
    await assert.rejects(call(client, 'maps_search_saved', { lists: ['changed-list'] }), /changed-list: unexpected response format/);
  });
});
