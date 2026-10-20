import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { unlinkAccount } from '../src/link.js';
import { call, cli, connect, link, OWNER, setup, signInAndGetTokens, WORK } from './helpers/harness.js';

describe('accounts (npm run link)', () => {
  let ctx, client;
  before(async () => {
    ctx = await setup();
    client = await connect(ctx, (await signInAndGetTokens(ctx)).access_token);
  });
  after(() => ctx.teardown());

  test('links accounts through a localhost redirect; the running server sees them', async () => {
    for (const email of [OWNER, WORK]) {
      const { url, res, linked } = await link(ctx, email);
      const q = new URL(url).searchParams;
      assert.match(q.get('scope'), /gmail\.modify/);
      assert.equal(q.get('access_type'), 'offline');
      assert.match(q.get('redirect_uri'), /^http:\/\/localhost:\d+\/callback$/);
      assert.equal(linked, email);
      assert.match(await res.text(), new RegExp(`Linked ${email}`));
    }
    assert.deepEqual((await call(client, 'list_accounts')).sort(), [OWNER, WORK]);
  });

  test('requires an account when several are linked', async () => {
    await assert.rejects(call(client, 'list_labels'), /Specify an account/);
    await assert.rejects(call(client, 'list_labels', { account: 'nobody@example.com' }), /Unknown account/);
  });

  test('unlinking revokes the Google grant', async () => {
    await unlinkAccount({ ...cli(ctx), email: WORK });
    assert.deepEqual(await call(client, 'list_accounts'), [OWNER]);
    assert.ok(![...ctx.google.state.refreshTokens.values()].includes(WORK));
  });
});
