import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { call, connect, decodeRaw, link, OWNER, setup, signInAndGetTokens, WORK } from './helpers/harness.js';

describe('mail', () => {
  let ctx, client;
  before(async () => {
    ctx = await setup();
    await link(ctx, OWNER);
    await link(ctx, WORK);
    client = await connect(ctx, (await signInAndGetTokens(ctx)).access_token);
  });
  after(() => ctx.teardown());

  test('searches across all accounts, or one', async () => {
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
    assert.equal(msg.from, 'Alice <alice@example.com>');
    assert.equal(msg.body, 'invoice attached');
    assert.deepEqual(msg.attachments, ['invoice.pdf']);
  });

  test('replies in-thread with correct headers', async () => {
    const sent = await call(client, 'send_email', { account: OWNER, reply_to_message_id: 'm1', body: 'Thanks!' });
    assert.equal(sent.thread_id, 't1');
    const mime = decodeRaw(ctx.google.mailbox(OWNER).sent[0].raw);
    assert.match(mime, /^To: Alice <alice@example\.com>\r$/m);
    assert.match(mime, /^Subject: Re: Your invoice\r$/m);
    assert.match(mime, /^In-Reply-To: <m1@example\.com>\r$/m);
    assert.match(mime, /^References: <m1@example\.com>\r$/m);
    assert.equal(Buffer.from(mime.split('\r\n\r\n')[1], 'base64').toString(), 'Thanks!');
  });

  test('rejects header injection', async () => {
    const args = { account: OWNER, to: 'a@example.com', subject: 'hi\r\nBcc: spy@evil.example', body: 'x' };
    await assert.rejects(call(client, 'send_email', args), /line breaks/);
    assert.equal(ctx.google.mailbox(OWNER).sent.length, 1);
  });

  test('creates a draft with a UTF-8 subject', async () => {
    await call(client, 'create_draft', { account: WORK, to: 'bob@corp.example', subject: 'Café ☕', body: 'draft' });
    const mime = decodeRaw(ctx.google.mailbox(WORK).drafts[0].message.raw);
    assert.ok(mime.includes(`Subject: =?UTF-8?B?${Buffer.from('Café ☕').toString('base64')}?=\r\n`));
  });

  test('lists labels, modifies and trashes threads', async () => {
    assert.ok((await call(client, 'list_labels', { account: OWNER })).some((l) => l.name === 'Receipts'));
    await call(client, 'modify_thread', { account: OWNER, thread_id: 't1', add_labels: ['STARRED'], remove_labels: ['UNREAD'] });
    assert.deepEqual(ctx.google.mailbox(OWNER).threads[0].messages[0].labelIds, ['INBOX', 'STARRED']);
    await call(client, 'trash_thread', { account: WORK, thread_id: 'w1' });
    assert.deepEqual(ctx.google.mailbox(WORK).threads[0].messages[0].labelIds, ['UNREAD', 'TRASH']);
  });
});
