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
    assert.deepEqual(sent.attachments, ['invoice.pdf']);
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
    msg.payload.parts.push({ mimeType: 'message/rfc822', filename: `\ud800${'x'.repeat(3000)}`, body: { data: 'eA', size: 1 } });
    msg.payload.parts.push({ mimeType: 'text/plain', filename: `${'y'.repeat(199)}😀`, body: { data: 'eA', size: 1 } });
    ctx.google.mailbox(OWNER).threads.push({ id: 't9', messages: [msg] });
    await call(client, 'mail_forward_message', { account: OWNER, message_id: 'm9', to: 'carol@example.com' });
    const mime = decodeRaw(ctx.google.mailbox(OWNER).sent.at(-1).raw);
    assert.doesNotMatch(mime, /^Bcc:/m);
    assert.match(mime, /^Subject: Fwd: hi\r$/m);
    assert.match(mime, /Content-Type: application\/octet-stream\r\nContent-Disposition: attachment; filename="a___Bcc: spy@evil\.example__\.pdf"\r\n/);
    assert.match(mime, /filename\*=UTF-8''caf%C3%A9\.png\r\n/);
    assert.match(mime, /Content-Type: application\/octet-stream\r\nContent-Disposition: attachment; filename\*=UTF-8''%EF%BF%BDx{199}\r\n/);
    assert.match(mime, /filename\*=UTF-8''y{199}%EF%BF%BD\r\n/);
  });

  test("doesn't carry the original's inline image IDs into a forward", async () => {
    const msg = gmailMessage({ id: 'm40', threadId: 't40', from: 'eve@example.com', subject: 'pic', body: 'x' });
    msg.payload.parts[1] = { mimeType: 'image/png', filename: 'pic.png', headers: [{ name: 'Content-ID', value: '<ii_9>' }], body: { data: 'eA', size: 1 } };
    ctx.google.mailbox(OWNER).threads.push({ id: 't40', messages: [msg] });
    await call(client, 'mail_forward_message', { account: OWNER, message_id: 'm40', to: 'carol@example.com' });
    const mime = decodeRaw(ctx.google.mailbox(OWNER).sent.at(-1).raw);
    assert.match(mime, /Content-Disposition: attachment; filename="pic\.png"/);
    assert.doesNotMatch(mime, /Content-ID/);
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
      await assert.rejects(call(client, 'mail_trash_message', { account: OWNER, message_id: thread_id }), /non-empty ID/);
    }
    const args = { account: OWNER, reply_to_message_id: '..', body: 'x' };
    await assert.rejects(call(client, 'mail_create_draft', args), /non-empty ID/);
    for (const tool of ['mail_get_draft', 'mail_update_draft', 'mail_send_draft', 'mail_delete_draft']) {
      await assert.rejects(call(client, tool, { account: OWNER, draft_id: '..' }), /non-empty ID/);
    }
  });

  test('creates a draft with a UTF-8 subject', async () => {
    await call(client, 'mail_create_draft', { account: WORK, to: 'bob@corp.example', subject: 'Café ☕', body: 'draft' });
    const mime = decodeRaw(ctx.google.mailbox(WORK).drafts[0].message.raw);
    assert.ok(mime.includes(`Subject: =?UTF-8?B?${Buffer.from('Café ☕').toString('base64')}?=\r\n`));
  });

  // A reply draft as Gmail returns it, with an attachment.
  const seedDraft = (id) => {
    const message = gmailMessage({ id: `${id}-msg`, threadId: 't1', from: OWNER, subject: 'Re: Your invoice', body: 'Draft text' });
    const extra = { 'Reply-To': 'replies@example.com', To: 'Alice <alice@example.com>', Cc: 'cc@example.com', Bcc: 'bcc@example.com', 'In-Reply-To': '<m1@example.com>', References: '<m1@example.com>' };
    message.payload.headers.push(...Object.entries(extra).map(([name, value]) => ({ name, value })));
    ctx.google.mailbox(OWNER).drafts.push({ id, message });
  };

  test('lists and reads drafts', async () => {
    seedDraft('d1');
    const list = await call(client, 'mail_list_drafts', {});
    const d1 = list.find((d) => d.draft_id === 'd1');
    assert.deepEqual([d1.account, d1.thread_id, d1.to, d1.subject, d1.snippet], [OWNER, 't1', 'Alice <alice@example.com>', 'Re: Your invoice', 'Draft text']);
    assert.ok(list.some((d) => d.account === WORK));
    const draft = await call(client, 'mail_get_draft', { account: OWNER, draft_id: 'd1' });
    assert.deepEqual([draft.bcc, draft.body, draft.attachments], ['bcc@example.com', 'Draft text', ['invoice.pdf']]);
  });

  test('updates a draft, keeping unchanged fields, threading and attachments', async () => {
    seedDraft('d2');
    const d2 = ctx.google.mailbox(OWNER).drafts.at(-1);
    d2.message.payload.headers.find((h) => h.name === 'From').value = 'Alias <alias@example.com>';
    const updated = await call(client, 'mail_update_draft', { account: OWNER, draft_id: 'd2', body: 'New text', cc: '' });
    assert.deepEqual([updated.draft_id, updated.thread_id], ['d2', 't1']);
    const { message } = ctx.google.mailbox(OWNER).drafts.find((d) => d.id === 'd2');
    assert.equal(message.threadId, 't1');
    const mime = decodeRaw(message.raw);
    assert.match(mime, /^From: Alias <alias@example\.com>\r$/m);
    assert.match(mime, /^Reply-To: replies@example\.com\r$/m);
    assert.match(mime, /^To: Alice <alice@example\.com>\r$/m);
    assert.match(mime, /^Bcc: bcc@example\.com\r$/m);
    assert.doesNotMatch(mime, /^Cc:/m);
    assert.match(mime, /^Subject: Re: Your invoice\r$/m);
    assert.match(mime, /^In-Reply-To: <m1@example\.com>\r$/m);
    assert.match(mime, /^References: <m1@example\.com>\r$/m);
    const boundary = mime.match(/boundary="([^"]+)"/)[1];
    const [, text, file] = mime.split(`--${boundary}`);
    assert.equal(Buffer.from(text.split('\r\n\r\n')[1], 'base64').toString(), 'New text');
    assert.match(file, /filename="invoice\.pdf"/);
  });

  // A draft written in Gmail: HTML, a plain-text copy Gmail hard-wraps with CRLF, and an inline image.
  const seedGmailDraft = (id) => {
    const b64 = (t) => Buffer.from(t).toString('base64url');
    const plain = 'Had a few follow up questions for the Egypt trip. We both\r\nland after the welcome meeting.\r\n\r\nThanks';
    const html = '<div dir="ltr">Had a few follow up questions for the Egypt trip. We both land after the welcome meeting.<div><br></div><div>Thanks &amp; <img src="cid:ii_1"></div></div>';
    const headers = [['From', OWNER], ['To', 'jess@example.com'], ['Subject', 'Re: trip']].map(([name, value]) => ({ name, value }));
    const message = {
      id: `${id}-msg`,
      threadId: 't1',
      labelIds: ['DRAFT'],
      payload: {
        mimeType: 'multipart/related',
        headers,
        parts: [
          { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64(plain) } }, { mimeType: 'text/html', body: { data: b64(html) } }] },
          { mimeType: 'image/png', filename: 'map.png', headers: [{ name: 'Content-ID', value: '<ii_1>' }], body: { data: b64('PNG'), size: 3 } },
        ],
      },
    };
    ctx.google.mailbox(OWNER).drafts.push({ id, message });
    return { plain, html };
  };
  // Splits a raw message into its leaf parts as { type, headers, text }.
  const leafParts = (mime) => {
    const boundary = mime.match(/boundary="([^"]+)"/)?.[1];
    if (!boundary) {
      const [head, body] = mime.split('\r\n\r\n');
      return [{ type: head.match(/^Content-Type: ([^;\r]+)/m)[1], headers: head, text: Buffer.from(body, 'base64').toString() }];
    }
    return mime.split(`--${boundary}`).slice(1, -1).flatMap((p) => leafParts(p.replace(/^\r\n/, '')));
  };

  test("reads a Gmail-written draft from its HTML, without Gmail's hard wraps", async () => {
    seedGmailDraft('d31');
    const draft = await call(client, 'mail_get_draft', { account: OWNER, draft_id: 'd31' });
    assert.equal(draft.body, 'Had a few follow up questions for the Egypt trip. We both land after the welcome meeting.\n\nThanks &');
  });

  test('keeps the HTML, plain text and inline images of a draft when only its recipients change', async () => {
    const { plain, html } = seedGmailDraft('d32');
    await call(client, 'mail_update_draft', { account: OWNER, draft_id: 'd32', to: 'jess@example.com, josh@example.com' });
    const mime = decodeRaw(ctx.google.mailbox(OWNER).drafts.find((d) => d.id === 'd32').message.raw);
    assert.match(mime, /^To: jess@example\.com, josh@example\.com\r$/m);
    const [text, htmlPart, image] = leafParts(mime);
    assert.deepEqual([text.type, text.text], ['text/plain', plain]);
    assert.deepEqual([htmlPart.type, htmlPart.text], ['text/html', html]);
    assert.match(image.headers, /Content-Disposition: inline; filename="map\.png"\r\nContent-ID: <ii_1>/);
  });

  test('saves a new draft body as plain text only', async () => {
    seedGmailDraft('d33');
    await call(client, 'mail_update_draft', { account: OWNER, draft_id: 'd33', body: 'New text' });
    const mime = decodeRaw(ctx.google.mailbox(OWNER).drafts.find((d) => d.id === 'd33').message.raw);
    assert.deepEqual(leafParts(mime).map((p) => p.type), ['text/plain', 'image/png']);
    assert.equal(leafParts(mime)[0].text, 'New text');
  });

  test("ignores attachments' and forwarded messages' HTML when reading or updating a draft", async () => {
    const b64 = (t) => Buffer.from(t).toString('base64url');
    const message = {
      id: 'd34-msg',
      threadId: 't1',
      labelIds: ['DRAFT'],
      payload: {
        mimeType: 'multipart/mixed',
        headers: [{ name: 'To', value: 'jess@example.com' }],
        parts: [
          { mimeType: 'text/plain', body: { data: b64('my own text') } },
          { mimeType: 'message/rfc822', filename: 'fwd.eml', body: { attachmentId: 'a3', size: 11 }, parts: [{ mimeType: 'text/html', body: { data: b64('<p>ATTACKER</p>') } }] },
          { mimeType: 'text/html', filename: 'page.html', body: { data: b64('<p>ATTACKER</p>'), size: 15 } },
        ],
      },
    };
    ctx.google.mailbox(OWNER).drafts.push({ id: 'd34', message });
    assert.equal((await call(client, 'mail_get_draft', { account: OWNER, draft_id: 'd34' })).body, 'my own text');
    await call(client, 'mail_update_draft', { account: OWNER, draft_id: 'd34', cc: 'josh@example.com' });
    const mime = decodeRaw(ctx.google.mailbox(OWNER).drafts.find((d) => d.id === 'd34').message.raw);
    assert.deepEqual(leafParts(mime).map((p) => [p.type, p.text.slice(0, 11)]), [['text/plain', 'my own text'], ['application/octet-stream', '%PDF-a3....'], ['text/html', '<p>ATTACKER']]);
    assert.doesNotMatch(mime, /multipart\/alternative/);
  });

  test("hides only what mail clients hide when reading a draft's HTML", async () => {
    const b64 = (t) => Buffer.from(t).toString('base64url');
    const cases = [
      // Lowercasing İ adds a character, so positions from a lowercased copy would cut the wrong text.
      [`<div>${'İ'.repeat(25)}</div><style>p{}</style><p>Please do NOT wire the money.</p>`, `${'İ'.repeat(25)}\nPlease do NOT wire the money.`],
      ['<p>a</p><STYLE type="x">x</style ><!-- <style> --><styles>b</styles><script>c()</SCRIPT>d', 'a\nbd'],
      ['a<style>unclosed', 'aunclosed'],
    ];
    for (const [i, [html, text]] of cases.entries()) {
      const message = { id: `d4${i}-msg`, threadId: 't1', labelIds: ['DRAFT'], payload: { mimeType: 'text/html', headers: [], body: { data: b64(html) } } };
      ctx.google.mailbox(OWNER).drafts.push({ id: `d4${i}`, message });
      assert.equal((await call(client, 'mail_get_draft', { account: OWNER, draft_id: `d4${i}` })).body, text);
    }
  });

  test('reads hostile draft HTML quickly and without crashing', async () => {
    const b64 = (t) => Buffer.from(t).toString('base64url');
    for (const [id, html] of [['d35', '<'.repeat(1e6)], ['d36', '<style'.repeat(2e5)], ['d37', 'a&#99999999;b']]) {
      const message = { id: `${id}-msg`, threadId: 't1', labelIds: ['DRAFT'], payload: { mimeType: 'text/html', headers: [], body: { data: b64(html) } } };
      ctx.google.mailbox(OWNER).drafts.push({ id, message });
      const start = Date.now();
      await call(client, 'mail_get_draft', { account: OWNER, draft_id: id });
      assert.ok(Date.now() - start < 1000, `${id} took ${Date.now() - start} ms`);
    }
    assert.equal((await call(client, 'mail_get_draft', { account: OWNER, draft_id: 'd37' })).body, 'a&#99999999;b');
  });

  test('rejects header injection when updating a draft', async () => {
    seedDraft('d3');
    const args = { account: OWNER, draft_id: 'd3', subject: 'hi\r\nBcc: spy@evil.example' };
    await assert.rejects(call(client, 'mail_update_draft', args), /line breaks/);
    assert.equal(ctx.google.mailbox(OWNER).drafts.find((d) => d.id === 'd3').message.raw, undefined);
  });

  test('sends and deletes drafts', async () => {
    seedDraft('d4');
    const recipientArgs = { to: 'Alice  <ALICE@example.com>', cc: 'cc@example.com', bcc: 'bcc@example.com' };
    const sent = await call(client, 'mail_send_draft', { account: OWNER, draft_id: 'd4', ...recipientArgs });
    assert.deepEqual([sent.thread_id, sent.to, sent.bcc], ['t1', 'Alice <alice@example.com>', 'bcc@example.com']);
    seedDraft('d5');
    assert.deepEqual(await call(client, 'mail_delete_draft', { account: OWNER, draft_id: 'd5' }), { ok: true });
    const ids = ctx.google.mailbox(OWNER).drafts.map((d) => d.id);
    assert.ok(!ids.includes('d4') && !ids.includes('d5'));
    await assert.rejects(call(client, 'mail_delete_draft', { account: OWNER, draft_id: 'd5' }), /404/);
  });

  test('sends a draft only to the recipients named in the call', async () => {
    // A draft made without approval, then sent: the approval prompt must show where it goes.
    const { draft_id } = await call(client, 'mail_create_draft', { account: OWNER, to: 'spy@evil.example', subject: 's', body: 'secret' });
    const before = ctx.google.mailbox(OWNER).sent.length;
    for (const recipientArgs of [{ to: 'alice@example.com' }, { to: 'spy@evil.example', bcc: 'x@example.com' }]) {
      await assert.rejects(call(client, 'mail_send_draft', { account: OWNER, draft_id, ...recipientArgs }), /nothing was sent/);
    }
    // Quoted local parts must not hide a recipient or disguise one as another.
    for (const [draftArgs, sendArgs] of [
      [{ to: 'alice@example.com', bcc: '"spy"@evil.example' }, { to: 'alice@example.com' }],
      [{ to: '"alice@example.com"@evil.example' }, { to: 'alice@example.com' }],
      // Copying the header exactly isn't enough when it could render misleadingly.
      [{ to: '"\u202emoc.elpmaxe@ecila\u202c" <spy@evil.example>' }, { to: '"\u202emoc.elpmaxe@ecila\u202c" <spy@evil.example>' }],
      [{ to: `"${'a'.repeat(2000)}" <spy@evil.example>` }, { to: `"${'a'.repeat(2000)}" <spy@evil.example>` }],
    ]) {
      const quoted = await call(client, 'mail_create_draft', { account: OWNER, ...draftArgs, subject: 's', body: 'secret' });
      await assert.rejects(call(client, 'mail_send_draft', { account: OWNER, draft_id: quoted.draft_id, ...sendArgs }), /nothing was sent/);
    }
    await assert.rejects(call(client, 'mail_send_draft', { account: OWNER, draft_id }), /to/);
    assert.equal(ctx.google.mailbox(OWNER).sent.length, before);
    const sent = await call(client, 'mail_send_draft', { account: OWNER, draft_id, to: ' SPY@evil.example ' });
    assert.equal(sent.to, 'spy@evil.example');
    assert.equal(ctx.google.mailbox(OWNER).sent.length, before + 1);
  });

  test('marks tools that send, overwrite or delete as destructive', async () => {
    const { tools } = await client.listTools();
    const destructive = tools.filter((t) => t.name.startsWith('mail_') && t.annotations.destructiveHint).map((t) => t.name);
    assert.deepEqual(destructive.sort(), [
      'mail_delete_draft', 'mail_forward_message', 'mail_send_draft', 'mail_send_email', 'mail_trash_message', 'mail_trash_thread', 'mail_update_draft',
    ]);
  });

  test('lists labels, modifies and trashes threads', async () => {
    assert.ok((await call(client, 'mail_list_labels', { account: OWNER })).some((l) => l.name === 'Receipts'));
    await call(client, 'mail_modify_thread', { account: OWNER, thread_id: 't1', add_labels: ['STARRED'], remove_labels: ['UNREAD'] });
    assert.deepEqual(ctx.google.mailbox(OWNER).threads[0].messages[0].labelIds, ['INBOX', 'STARRED']);
    await call(client, 'mail_trash_thread', { account: WORK, thread_id: 'w1' });
    assert.deepEqual(ctx.google.mailbox(WORK).threads[0].messages[0].labelIds, ['UNREAD', 'TRASH']);
  });

  test('trashes one message, leaving the rest of its thread', async () => {
    const reply = gmailMessage({ id: 'm12', threadId: 't12', from: 'bob@example.com', subject: 'Re: plan', body: 'second' });
    const first = gmailMessage({ id: 'm11', threadId: 't12', from: 'alice@example.com', subject: 'plan', body: 'first' });
    ctx.google.mailbox(OWNER).threads.push({ id: 't12', messages: [first, reply] });
    const trashed = await call(client, 'mail_trash_message', { account: OWNER, message_id: 'm12' });
    assert.deepEqual(trashed, { ok: true, from: 'bob@example.com', subject: 'Re: plan' });
    assert.deepEqual([first.labelIds, reply.labelIds], [['INBOX', 'UNREAD'], ['UNREAD', 'TRASH']]);
    await assert.rejects(call(client, 'mail_trash_message', { account: OWNER, message_id: 'missing' }), /404/);
  });

  test('finds a draft reply in a thread and deletes it', async () => {
    const sent = gmailMessage({ id: 'm21', threadId: 't21', from: 'alice@example.com', subject: 'lunch', body: 'lunch?' });
    const draft = gmailMessage({ id: 'm22', threadId: 't21', from: OWNER, subject: 'Re: lunch', body: 'sure' });
    draft.labelIds = ['DRAFT'];
    ctx.google.mailbox(OWNER).threads.push({ id: 't21', messages: [sent, draft] });
    ctx.google.mailbox(OWNER).drafts.push({ id: 'd21', message: draft });
    const messages = await call(client, 'mail_get_thread', { account: OWNER, thread_id: 't21' });
    assert.deepEqual(messages.map((m) => [m.message_id, m.draft_id]), [['m21', undefined], ['m22', 'd21']]);
    await assert.rejects(call(client, 'mail_trash_message', { account: OWNER, message_id: 'm22' }), /mail_delete_draft/);
    await call(client, 'mail_delete_draft', { account: OWNER, draft_id: 'd21' });
    assert.ok(!ctx.google.mailbox(OWNER).drafts.some((d) => d.id === 'd21'));
  });
});
