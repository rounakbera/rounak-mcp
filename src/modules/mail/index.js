import { z } from 'zod';
import { account, DESTRUCTIVE, READ, WRITE } from '../../tools.js';
import { bodyText, header, parts, rawMessage } from './mime.js';

const MAX_BODY_CHARS = 20_000;

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

export default {
  scopes: ['https://www.googleapis.com/auth/gmail.modify'],

  register({ google, linked, resolve, tool }) {
    const api = (email, method, path, body) => google.request(email, method, `${google.endpoints.gmail}${path}`, body);
    const gmail = (args, method, path, body) => api(resolve(args.account), method, path, body);
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

    tool(
      'mail_search_threads',
      'Search Gmail threads with Gmail query syntax. Searches every linked account unless `account` is given.',
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
            const { threads = [] } = await api(acct, 'GET', `/threads?${q}`);
            return Promise.all(
              threads.map(async ({ id }) => {
                const meta = 'format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date';
                const { messages } = await api(acct, 'GET', `${thread(id)}?${meta}`);
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

    tool('mail_get_thread', 'Read every message in a Gmail thread', { thread_id: threadId, account }, READ, async (args) => {
      const { messages } = await gmail(args, 'GET', `${thread(args.thread_id)}?format=full`);
      return messages.map((m) => ({
        message_id: m.id,
        ...Object.fromEntries(['From', 'To', 'Cc', 'Date', 'Subject'].map((h) => [h.toLowerCase(), header(m, h)])),
        labels: m.labelIds,
        body: bodyText(m.payload).slice(0, MAX_BODY_CHARS),
        attachments: parts(m.payload).filter((p) => p.filename).map((p) => p.filename),
      }));
    });

    tool('mail_send_email', 'Send an email, or reply to a message', composeArgs, DESTRUCTIVE, async (args) => {
      const { id, threadId } = await gmail(args, 'POST', '/messages/send', await compose(args));
      return { message_id: id, thread_id: threadId };
    });

    tool('mail_create_draft', 'Create a draft email or draft reply without sending it', composeArgs, WRITE, async (args) => {
      const draft = await gmail(args, 'POST', '/drafts', { message: await compose(args) });
      return { draft_id: draft.id, thread_id: draft.message?.threadId };
    });

    tool('mail_list_labels', 'List Gmail labels and their IDs', { account }, READ, async (args) => {
      const { labels = [] } = await gmail(args, 'GET', '/labels');
      return labels.map(({ id, name, type }) => ({ id, name, type }));
    });

    tool(
      'mail_modify_thread',
      'Add or remove label IDs on a thread. Archive = remove INBOX; mark read = remove UNREAD; star = add STARRED.',
      { thread_id: threadId, account, add_labels: z.array(z.string()).default([]), remove_labels: z.array(z.string()).default([]) },
      WRITE,
      async (args) => {
        await gmail(args, 'POST', `${thread(args.thread_id)}/modify`, { addLabelIds: args.add_labels, removeLabelIds: args.remove_labels });
        return { ok: true };
      },
    );

    tool('mail_trash_thread', 'Move a Gmail thread to Trash', { thread_id: threadId, account }, DESTRUCTIVE, async (args) => {
      await gmail(args, 'POST', `${thread(args.thread_id)}/trash`);
      return { ok: true };
    });
  },
};
