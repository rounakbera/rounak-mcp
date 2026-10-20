import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { call, connect, link, OWNER, setup, signInAndGetTokens, startApp, token } from './helpers/harness.js';

describe('persistence', () => {
  let ctx, tokens;
  before(async () => {
    ctx = await setup();
    await link(ctx, OWNER);
    tokens = await signInAndGetTokens(ctx);
  });
  after(() => ctx.teardown());

  test('state is encrypted at rest', () => {
    const file = readFileSync(join(ctx.dataDir, 'state.enc'));
    for (const secret of [OWNER, 'rt-', tokens.refresh_token]) assert.ok(!file.includes(secret), `${secret} leaked`);
  });

  test('accounts and refresh tokens survive a restart; access tokens do not', async () => {
    ctx.app.close();
    await startApp(ctx);
    const stale = await fetch(new URL('/mcp', ctx.app.base), { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}` } });
    assert.equal(stale.status, 401);

    const refreshed = await token(ctx, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    assert.equal(refreshed.status, 200);
    const client = await connect(ctx, refreshed.body.access_token);
    const grants = ctx.google.state.refreshGrants;
    assert.equal((await call(client, 'search_threads', { query: 'invoice' })).length, 1);
    assert.equal(ctx.google.state.refreshGrants, grants + 1, 'Google access token refreshed from the stored refresh token');
  });
});
