import { z } from 'zod';

const MAX_BODY_CHARS = 20_000;

const singleLine = z.string().regex(/^[^\r\n]*$/, 'must not contain line breaks');
const account = z.string().optional().describe('Gmail address to use; optional when only one account is linked');
const compose = {
  account,
  to: singleLine.optional().describe('Comma-separated recipients; defaults to the original sender when replying'),
  cc: singleLine.optional(),
  bcc: singleLine.optional(),
  subject: singleLine.optional().describe('Defaults to "Re: <original subject>" when replying'),
  body: z.string().describe('Plain-text body'),
  reply_to_message_id: z.string().optional().describe('Message ID to reply to; keeps the reply in its thread'),
};

const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const header = (msg, name) =>
  msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
const decode = (data) => Buffer.from(data, 'base64url').toString();

function flatten(part) {
  return [part, ...(part?.parts ?? []).flatMap(flatten)];
}

function bodyText(payload) {
  const parts = flatten(payload);
  const plain = parts.find((p) => p.mimeType === 'text/plain' && p.body?.data);
  if (plain) return decode(plain.body.data);
  const html = parts.find((p) => p.mimeType === 'text/html' && p.body?.data);
  return html ? decode(html.body.data).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

function encodeHeader(value) {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`;
}

function rawMessage({ to, cc, bcc, subject, body, inReplyTo, references }) {
  const headers = [
    ['To', to],
    ['Cc', cc],
    ['Bcc', bcc],
    ['Subject', subject && encodeHeader(subject)],
    ['In-Reply-To', inReplyTo],
    ['References', references],
    ['MIME-Version', '1.0'],
    ['Content-Type', 'text/plain; charset=UTF-8'],
    ['Content-Transfer-Encoding', 'base64'],
  ].filter(([, v]) => v);
  const encodedBody = Buffer.from(body).toString('base64').replace(/.{76}/g, '$&\r\n');
  const mime = `${headers.map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${encodedBody}`;
  return Buffer.from(mime).toString('base64url');
}

export function registerTools(server, { store, google, auth }) {
  const linked = () => Object.keys(store.data.accounts);

  function resolve(email) {
    const all = linked();
    if (email) {
      if (!all.includes(email.toLowerCase())) throw new Error(`Unknown account ${email}. Linked: ${all.join(', ')}`);
      return email.toLowerCase();
    }
    if (all.length === 1) return all[0];
    throw new Error(`Specify an account: ${all.join(', ')}`);
  }

  async function buildMessage(email, args) {
    const fields = { ...args };
    let threadId;
    if (args.reply_to_message_id) {
      const meta = ['Message-ID', 'References', 'Subject', 'From', 'Reply-To'].map((h) => `metadataHeaders=${h}`);
      const orig = await google.gmail(email, 'GET', `/messages/${encodeURIComponent(args.reply_to_message_id)}?format=metadata&${meta.join('&')}`);
      const messageId = header(orig, 'Message-ID');
      const subject = header(orig, 'Subject') ?? '';
      threadId = orig.threadId;
      fields.to ??= header(orig, 'Reply-To') ?? header(orig, 'From');
      fields.subject ??= /^re:/i.test(subject) ? subject : `Re: ${subject}`;
      fields.inReplyTo = messageId;
      fields.references = [header(orig, 'References'), messageId].filter(Boolean).join(' ');
    }
    if (!fields.to) throw new Error('`to` is required unless replying');
    // Header values from the original message come from a third party; reject any that could inject headers.
    for (const v of [fields.to, fields.subject, fields.inReplyTo, fields.references]) {
      if (v && /[\r\n]/.test(v)) throw new Error('Header values must not contain line breaks');
    }
    return { raw: rawMessage(fields), ...(threadId && { threadId }) };
  }

  server.registerTool('list_accounts', { description: 'List linked Gmail accounts', annotations: READ }, async () =>
    json(Object.entries(store.data.accounts).map(([email, a]) => ({ email, linked_at: a.linkedAt }))),
  );

  server.registerTool(
    'link_account',
    {
      description: 'Get a one-time URL (valid 10 minutes) that the user opens to link another Gmail account',
      annotations: WRITE,
    },
    async () => json({ url: auth.linkUrl() }),
  );

  server.registerTool(
    'unlink_account',
    { description: 'Unlink a Gmail account and revoke its Google access', inputSchema: { account: z.string() }, annotations: DESTRUCTIVE },
    async (args) => {
      const email = resolve(args.account);
      await google.revoke(store.data.accounts[email].refreshToken);
      delete store.data.accounts[email];
      store.save();
      google.forget(email);
      return json({ unlinked: email });
    },
  );

  server.registerTool(
    'search_threads',
    {
      description: 'Search threads with Gmail query syntax. Searches every linked account unless `account` is given.',
      inputSchema: {
        query: z.string().describe('Gmail search query, e.g. "from:alice is:unread newer_than:7d"'),
        account,
        max_results: z.number().int().min(1).max(50).default(10).describe('Per account'),
      },
      annotations: READ,
    },
    async ({ query, account: email, max_results }) => {
      const emails = email ? [resolve(email)] : linked();
      const results = await Promise.all(
        emails.map(async (acct) => {
          const params = new URLSearchParams({ q: query, maxResults: String(max_results) });
          const { threads = [] } = await google.gmail(acct, 'GET', `/threads?${params}`);
          return Promise.all(
            threads.map(async ({ id }) => {
              const t = await google.gmail(acct, 'GET', `/threads/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
              const last = t.messages.at(-1);
              return {
                account: acct,
                thread_id: id,
                subject: header(t.messages[0], 'Subject'),
                from: header(last, 'From'),
                date: header(last, 'Date'),
                snippet: last.snippet,
                messages: t.messages.length,
                labels: last.labelIds,
              };
            }),
          );
        }),
      );
      return json(results.flat());
    },
  );

  server.registerTool(
    'get_thread',
    { description: 'Read every message in a thread', inputSchema: { thread_id: z.string(), account }, annotations: READ },
    async ({ thread_id, account: email }) => {
      const t = await google.gmail(resolve(email), 'GET', `/threads/${encodeURIComponent(thread_id)}?format=full`);
      return json(
        t.messages.map((m) => ({
          message_id: m.id,
          from: header(m, 'From'),
          to: header(m, 'To'),
          cc: header(m, 'Cc'),
          date: header(m, 'Date'),
          subject: header(m, 'Subject'),
          labels: m.labelIds,
          body: bodyText(m.payload).slice(0, MAX_BODY_CHARS),
          attachments: flatten(m.payload).filter((p) => p.filename).map((p) => p.filename),
        })),
      );
    },
  );

  server.registerTool(
    'send_email',
    { description: 'Send an email, or reply to a message', inputSchema: compose, annotations: DESTRUCTIVE },
    async (args) => {
      const email = resolve(args.account);
      const sent = await google.gmail(email, 'POST', '/messages/send', await buildMessage(email, args));
      return json({ account: email, message_id: sent.id, thread_id: sent.threadId });
    },
  );

  server.registerTool(
    'create_draft',
    { description: 'Create a draft email or draft reply without sending it', inputSchema: compose, annotations: WRITE },
    async (args) => {
      const email = resolve(args.account);
      const draft = await google.gmail(email, 'POST', '/drafts', { message: await buildMessage(email, args) });
      return json({ account: email, draft_id: draft.id, thread_id: draft.message?.threadId });
    },
  );

  server.registerTool(
    'list_labels',
    { description: 'List labels and their IDs', inputSchema: { account }, annotations: READ },
    async ({ account: email }) => {
      const { labels = [] } = await google.gmail(resolve(email), 'GET', '/labels');
      return json(labels.map(({ id, name, type }) => ({ id, name, type })));
    },
  );

  server.registerTool(
    'modify_thread',
    {
      description: 'Add or remove label IDs on a thread. Archive = remove INBOX; mark read = remove UNREAD; star = add STARRED.',
      inputSchema: {
        thread_id: z.string(),
        account,
        add_labels: z.array(z.string()).default([]),
        remove_labels: z.array(z.string()).default([]),
      },
      annotations: WRITE,
    },
    async ({ thread_id, account: email, add_labels, remove_labels }) => {
      const t = await google.gmail(resolve(email), 'POST', `/threads/${encodeURIComponent(thread_id)}/modify`, {
        addLabelIds: add_labels,
        removeLabelIds: remove_labels,
      });
      return json({ thread_id: t.id, ok: true });
    },
  );

  server.registerTool(
    'trash_thread',
    { description: 'Move a thread to Trash', inputSchema: { thread_id: z.string(), account }, annotations: DESTRUCTIVE },
    async ({ thread_id, account: email }) => {
      await google.gmail(resolve(email), 'POST', `/threads/${encodeURIComponent(thread_id)}/trash`);
      return json({ thread_id, trashed: true });
    },
  );
}
