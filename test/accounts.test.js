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
    await assert.rejects(call(client, 'mail_list_labels'), /Specify an account/);
    await assert.rejects(call(client, 'mail_list_labels', { account: 'nobody@example.com' }), /Unknown account/);
  });

  test('unlinking revokes the Google grant', async () => {
    await unlinkAccount({ ...cli(ctx), email: WORK });
    assert.deepEqual(await call(client, 'list_accounts'), [OWNER]);
    assert.ok(![...ctx.google.state.refreshTokens.values()].includes(WORK));
  });
});

describe('granted scopes', () => {
  let ctx, client;
  before(async () => {
    ctx = await setup();
    await link(ctx, OWNER);
    await link(ctx, WORK, ['mail']);
    client = await connect(ctx, (await signInAndGetTokens(ctx)).access_token);
  });
  after(() => ctx.teardown());

  test('records granted scopes; accounts that lack a module\'s are an error, never skipped', async () => {
    assert.deepEqual(cli(ctx).store.read().accounts[WORK].scopes, ['openid', 'email', 'https://www.googleapis.com/auth/gmail.modify']);
    const relink = /Re-link work@example\.com with `npm run link` to grant calendar access/;
    await assert.rejects(call(client, 'calendar_list_calendars', { account: WORK }), relink);
    assert.ok(Array.isArray(await call(client, 'mail_list_labels', { account: WORK })));
    ctx.google.calendar(OWNER).calendars.push({ id: OWNER, primary: true, selected: true });
    const range = { time_min: '2026-10-21T15:00:00Z', time_max: '2026-10-21T19:00:00Z' };
    await assert.rejects(call(client, 'calendar_find_free_time', range), relink);
    await assert.rejects(call(client, 'calendar_list_events', range), relink);
    assert.equal((await call(client, 'calendar_list_calendars', { account: OWNER }))[0].account, OWNER);
  });

  test('accounts linked before scopes were recorded are left to Google', async () => {
    cli(ctx).store.update(({ accounts }) => delete accounts[WORK].scopes);
    assert.deepEqual(await call(client, 'calendar_list_calendars', { account: WORK }), []);
  });
});
