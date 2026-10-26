import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { gmailMessage } from './helpers/fake-google.js';
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
    const results = await call(client, 'mail_search_threads', { query: 'invoice' });
    assert.deepEqual(results.map((r) => [r.account, r.thread_id, r.subject]).sort(), [
      [OWNER, 't1', 'Your invoice'],
      [WORK, 'w1', 'Q3 invoice'],
    ]);
    assert.equal(results.find((r) => r.thread_id === 't1').snippet, "invoice attached & it's — here");
    const workOnly = await call(client, 'mail_search_threads', { query: 'invoice', account: WORK });
    assert.deepEqual(workOnly.map((r) => r.thread_id), ['w1']);
  });

  test('reads a thread', async () => {
    const [msg] = await call(client, 'mail_get_thread', { account: OWNER, thread_id: 't1' });
    assert.equal(msg.from, 'Alice <alice@example.com>');
    assert.equal(msg.body, 'invoice attached');
    assert.deepEqual(msg.attachments, ['invoice.pdf']);
  });

  test('replies in-thread with correct headers', async () => {
    const sent = await call(client, 'mail_send_email', { account: OWNER, reply_to_message_id: 'm1', body: 'Thanks!' });
    assert.equal(sent.thread_id, 't1');
    const mime = decodeRaw(ctx.google.mailbox(OWNER).sent[0].raw);
    assert.match(mime, /^To: Alice <alice@example\.com>\r$/m);
    assert.match(mime, /^Subject: Re: Your invoice\r$/m);
    assert.match(mime, /^In-Reply-To: <m1@example\.com>\r$/m);
    assert.match(mime, /^References: <m1@example\.com>\r$/m);
    assert.equal(Buffer.from(mime.split('\r\n\r\n')[1], 'base64').toString(), 'Thanks!');
  });

  test('forwards a message with its attachments, in its thread', async () => {
    const args = { account: OWNER, message_id: 'm1', to: 'carol@example.com', body: 'FYI' };
    const sent = await call(client, 'mail_forward_message', args);
    assert.equal(sent.thread_id, 't1');
    const { raw, threadId } = ctx.google.mailbox(OWNER).sent.at(-1);
    assert.equal(threadId, 't1');
    const mime = decodeRaw(raw);
    assert.match(mime, /^To: carol@example\.com\r$/m);
    assert.match(mime, /^Subject: Fwd: Your invoice\r$/m);
    assert.match(mime, /^In-Reply-To: <m1@example\.com>\r$/m);
    const boundary = mime.match(/^Content-Type: multipart\/mixed; boundary="([^"]+)"\r$/m)[1];
    const [, text, file] = mime.split(`--${boundary}`);
    const decode = (part) => Buffer.from(part.split('\r\n\r\n')[1], 'base64').toString();
    assert.match(decode(text), /^FYI\n\n---------- Forwarded message ---------\nFrom: Alice <alice@example\.com>\n[^]*\ninvoice attached$/);
    assert.match(file, /Content-Type: application\/pdf\r\nContent-Disposition: attachment; filename="invoice\.pdf"/);
    assert.equal(decode(file), '%PDF-a1....');
  });

  test('forwards attachments with hostile names and types as safe headers', async () => {
    const msg = gmailMessage({ id: 'm9', threadId: 't9', from: 'eve@example.com', subject: 'Fwd: hi', body: 'x' });
    msg.payload.parts[1] = { mimeType: 'text/html\r\nBcc: spy@evil.example', filename: 'a"\r\nBcc: spy@evil.example\r\n.pdf', body: { data: 'eA', size: 1 } };
    msg.payload.parts.push({ mimeType: 'image/png', filename: 'café.png', body: { attachmentId: 'a2', size: 11 } });
    ctx.google.mailbox(OWNER).threads.push({ id: 't9', messages: [msg] });
    await call(client, 'mail_forward_message', { account: OWNER, message_id: 'm9', to: 'carol@example.com' });
    const mime = decodeRaw(ctx.google.mailbox(OWNER).sent.at(-1).raw);
    assert.doesNotMatch(mime, /^Bcc:/m);
    assert.match(mime, /^Subject: Fwd: hi\r$/m);
    assert.match(mime, /Content-Type: application\/octet-stream\r\nContent-Disposition: attachment; filename="a___Bcc: spy@evil\.example__\.pdf"\r\n/);
    assert.match(mime, /filename\*=UTF-8''caf%C3%A9\.png\r\n/);
  });

  test('refuses to forward attachments over 25 MB', async () => {
    const msg = gmailMessage({ id: 'm10', threadId: 't10', from: 'eve@example.com', subject: 'big', body: 'x' });
    msg.payload.parts[1].body.size = 26 * 1024 * 1024;
    ctx.google.mailbox(OWNER).threads.push({ id: 't10', messages: [msg] });
    const before = ctx.google.mailbox(OWNER).sent.length;
    await assert.rejects(call(client, 'mail_forward_message', { account: OWNER, message_id: 'm10', to: 'carol@example.com' }), /over 25 MB/);
    assert.equal(ctx.google.mailbox(OWNER).sent.length, before);
  });

  test('rejects header injection', async () => {
    const before = ctx.google.mailbox(OWNER).sent.length;
    const args = { account: OWNER, to: 'a@example.com', subject: 'hi\r\nBcc: spy@evil.example', body: 'x' };
    await assert.rejects(call(client, 'mail_send_email', args), /line breaks/);
    assert.equal(ctx.google.mailbox(OWNER).sent.length, before);
  });

  test('rejects IDs that would change the request path', async () => {
    for (const thread_id of ['..', '.', '']) {
      await assert.rejects(call(client, 'mail_trash_thread', { account: OWNER, thread_id }), /non-empty ID/);
    }
    const args = { account: OWNER, reply_to_message_id: '..', body: 'x' };
    await assert.rejects(call(client, 'mail_create_draft', args), /non-empty ID/);
  });

  test('creates a draft with a UTF-8 subject', async () => {
    await call(client, 'mail_create_draft', { account: WORK, to: 'bob@corp.example', subject: 'Café ☕', body: 'draft' });
    const mime = decodeRaw(ctx.google.mailbox(WORK).drafts[0].message.raw);
    assert.ok(mime.includes(`Subject: =?UTF-8?B?${Buffer.from('Café ☕').toString('base64')}?=\r\n`));
  });

  test('lists labels, modifies and trashes threads', async () => {
    assert.ok((await call(client, 'mail_list_labels', { account: OWNER })).some((l) => l.name === 'Receipts'));
    await call(client, 'mail_modify_thread', { account: OWNER, thread_id: 't1', add_labels: ['STARRED'], remove_labels: ['UNREAD'] });
    assert.deepEqual(ctx.google.mailbox(OWNER).threads[0].messages[0].labelIds, ['INBOX', 'STARRED']);
    await call(client, 'mail_trash_thread', { account: WORK, thread_id: 'w1' });
    assert.deepEqual(ctx.google.mailbox(WORK).threads[0].messages[0].labelIds, ['UNREAD', 'TRASH']);
  });
});
