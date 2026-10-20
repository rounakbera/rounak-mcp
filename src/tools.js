import { z } from 'zod';
import { bodyText, header, parts, rawMessage } from './mime.js';

const MAX_BODY_CHARS = 20_000;

const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

const account = z.string().optional().describe('Gmail address to use; optional when only one account is linked');
const threadId = z.string();
const composeArgs = {
  account,
  to: z.string().optional().describe('Comma-separated recipients; defaults to the original sender when replying'),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string().optional().describe('Defaults to "Re: <original subject>" when replying'),
  body: z.string().describe('Plain-text body'),
  reply_to_message_id: z.string().optional().describe('Message ID to reply to; keeps the reply in its thread'),
};

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

export function registerTools(server, { store, google }) {
  const linked = () => Object.keys(store.read().accounts);

  // Maps an optional `account` argument to a linked account's email.
  function resolve(email) {
    const all = linked();
    if (email) {
      if (!all.includes(email.toLowerCase())) throw new Error(`Unknown account ${email}. Linked: ${all.join(', ')}`);
      return email.toLowerCase();
    }
    if (all.length === 1) return all[0];
    throw new Error(`Specify an account: ${all.join(', ')}`);
  }

  const tool = (name, description, inputSchema, annotations, handler) =>
    server.registerTool(name, { description, inputSchema, annotations }, async (args) => json(await handler(args)));
  const gmail = (args, method, path, body) => google.gmail(resolve(args.account), method, path, body);
  const thread = (id) => `/threads/${encodeURIComponent(id)}`;

  // Builds the Gmail API message, filling reply headers from the original when replying.
  async function compose(args) {
    const fields = { ...args };
    let threadId;
    if (args.reply_to_message_id) {
      const meta = ['Message-ID', 'References', 'Subject', 'From', 'Reply-To'].map((h) => `metadataHeaders=${h}`).join('&');
      const orig = await gmail(args, 'GET', `/messages/${encodeURIComponent(args.reply_to_message_id)}?format=metadata&${meta}`);
      const messageId = header(orig, 'Message-ID');
      const subject = header(orig, 'Subject') ?? '';
      threadId = orig.threadId;
      fields.to ??= header(orig, 'Reply-To') ?? header(orig, 'From');
      fields.subject ??= /^re:/i.test(subject) ? subject : `Re: ${subject}`;
      fields.inReplyTo = messageId;
      fields.references = [header(orig, 'References'), messageId].filter(Boolean).join(' ');
    }
    if (!fields.to) throw new Error('`to` is required unless replying');
    return { raw: rawMessage(fields), threadId };
  }

  tool('list_accounts', 'List linked Gmail accounts', {}, READ, () => linked());

  tool(
    'search_threads',
    'Search threads with Gmail query syntax. Searches every linked account unless `account` is given.',
    {
      query: z.string().describe('Gmail search query, e.g. "from:alice is:unread newer_than:7d"'),
      account,
      max_results: z.number().int().min(1).max(50).default(10).describe('Per account'),
    },
    READ,
    async ({ query, account: email, max_results }) => {
      const results = await Promise.all(
        (email ? [resolve(email)] : linked()).map(async (acct) => {
          const q = new URLSearchParams({ q: query, maxResults: max_results });
          const { threads = [] } = await google.gmail(acct, 'GET', `/threads?${q}`);
          return Promise.all(
            threads.map(async ({ id }) => {
              const meta = 'format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date';
              const { messages } = await google.gmail(acct, 'GET', `${thread(id)}?${meta}`);
              const last = messages.at(-1);
              return {
                account: acct,
                thread_id: id,
                subject: header(messages[0], 'Subject'),
                from: header(last, 'From'),
                date: header(last, 'Date'),
                snippet: last.snippet,
                messages: messages.length,
                labels: last.labelIds,
              };
            }),
          );
        }),
      );
      return results.flat();
    },
  );

  tool('get_thread', 'Read every message in a thread', { thread_id: threadId, account }, READ, async (args) => {
    const { messages } = await gmail(args, 'GET', `${thread(args.thread_id)}?format=full`);
    return messages.map((m) => ({
      message_id: m.id,
      ...Object.fromEntries(['From', 'To', 'Cc', 'Date', 'Subject'].map((h) => [h.toLowerCase(), header(m, h)])),
      labels: m.labelIds,
      body: bodyText(m.payload).slice(0, MAX_BODY_CHARS),
      attachments: parts(m.payload).filter((p) => p.filename).map((p) => p.filename),
    }));
  });

  tool('send_email', 'Send an email, or reply to a message', composeArgs, DESTRUCTIVE, async (args) => {
    const { id, threadId } = await gmail(args, 'POST', '/messages/send', await compose(args));
    return { message_id: id, thread_id: threadId };
  });

  tool('create_draft', 'Create a draft email or draft reply without sending it', composeArgs, WRITE, async (args) => {
    const draft = await gmail(args, 'POST', '/drafts', { message: await compose(args) });
    return { draft_id: draft.id, thread_id: draft.message?.threadId };
  });

  tool('list_labels', 'List labels and their IDs', { account }, READ, async (args) => {
    const { labels = [] } = await gmail(args, 'GET', '/labels');
    return labels.map(({ id, name, type }) => ({ id, name, type }));
  });

  tool(
    'modify_thread',
    'Add or remove label IDs on a thread. Archive = remove INBOX; mark read = remove UNREAD; star = add STARRED.',
    { thread_id: threadId, account, add_labels: z.array(z.string()).default([]), remove_labels: z.array(z.string()).default([]) },
    WRITE,
    async (args) => {
      await gmail(args, 'POST', `${thread(args.thread_id)}/modify`, { addLabelIds: args.add_labels, removeLabelIds: args.remove_labels });
      return { ok: true };
    },
  );

  tool('trash_thread', 'Move a thread to Trash', { thread_id: threadId, account }, DESTRUCTIVE, async (args) => {
    await gmail(args, 'POST', `${thread(args.thread_id)}/trash`);
    return { ok: true };
  });
}
