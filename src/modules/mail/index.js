import { z } from 'zod';
import { account, DESTRUCTIVE, id, READ, WRITE } from '../../tools.js';
import { bodyText, header, parts, rawMessage, unescapeHtml } from './mime.js';

const MAX_BODY_CHARS = 20_000;
// Gmail's own limit on attachments in a sent message.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const threadId = id;
const composeArgs = {
  account,
  to: z.string().optional().describe('Comma-separated recipients; defaults to the original sender when replying'),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string().optional().describe('Defaults to "Re: <original subject>" when replying'),
  body: z.string().describe('Plain-text body'),
  reply_to_message_id: id.optional().describe('Message ID to reply to; keeps the reply in its thread'),
};

export default {
  scopes: ['https://www.googleapis.com/auth/gmail.modify'],

  register({ google, linked, resolve, tool }) {
    const api = (email, method, path, body) => google.request(email, method, `${google.endpoints.gmail}${path}`, body);
    const gmail = (args, method, path, body) => api(resolve(args.account), method, path, body);
    const thread = (id) => `/threads/${encodeURIComponent(id)}`;
    const draftPath = (id) => `/drafts/${encodeURIComponent(id)}`;
    const recipients = (msg) => Object.fromEntries(['To', 'Cc', 'Bcc', 'Subject'].map((h) => [h.toLowerCase(), header(msg, h)]));

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

    // Downloads a message's attachments, so they can be sent again in a new message.
    async function attachmentsOf(args, msg) {
      const files = parts(msg.payload).filter((p) => p.filename && (p.body?.attachmentId || p.body?.data));
      if (files.reduce((n, p) => n + (p.body.size ?? 0), 0) > MAX_ATTACHMENT_BYTES) throw new Error('Attachments are over 25 MB');
      const path = `/messages/${encodeURIComponent(msg.id)}/attachments/`;
      return Promise.all(
        files.map(async (p) => {
          const { data } = p.body.data ? p.body : await gmail(args, 'GET', path + encodeURIComponent(p.body.attachmentId));
          return { filename: p.filename, mimeType: p.mimeType, data: Buffer.from(data, 'base64url') };
        }),
      );
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
                  snippet: unescapeHtml(last.snippet),
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

    tool(
      'mail_list_drafts',
      'List drafts, optionally filtered with Gmail query syntax. Lists every linked account unless `account` is given.',
      {
        query: z.string().optional().describe('Gmail search query, e.g. "to:alice"'),
        account,
        max_results: z.number().int().min(1).max(50).default(10).describe('Per account'),
      },
      READ,
      async ({ query, account: email, max_results }) => {
        const results = await Promise.all(
          (email ? [resolve(email)] : linked()).map(async (acct) => {
            const q = new URLSearchParams({ maxResults: max_results, ...(query && { q: query }) });
            const { drafts = [] } = await api(acct, 'GET', `/drafts?${q}`);
            return Promise.all(
              drafts.map(async ({ id }) => {
                const { message } = await api(acct, 'GET', `${draftPath(id)}?format=metadata`);
                return { account: acct, draft_id: id, thread_id: message.threadId, ...recipients(message), snippet: unescapeHtml(message.snippet) };
              }),
            );
          }),
        );
        return results.flat();
      },
    );

    tool('mail_get_draft', 'Read a draft', { draft_id: id, account }, READ, async (args) => {
      const { message } = await gmail(args, 'GET', `${draftPath(args.draft_id)}?format=full`);
      return {
        draft_id: args.draft_id,
        thread_id: message.threadId,
        ...recipients(message),
        body: bodyText(message.payload).slice(0, MAX_BODY_CHARS),
        attachments: parts(message.payload).filter((p) => p.filename).map((p) => p.filename),
      };
    });

    tool(
      'mail_update_draft',
      'Change a draft. Fields left out keep their current value; pass an empty string to clear one. The draft is saved as plain text, so formatting from Gmail is lost. Reply threading and attachments are kept.',
      {
        draft_id: id,
        account,
        to: z.string().optional().describe('Comma-separated recipients'),
        cc: z.string().optional(),
        bcc: z.string().optional(),
        subject: z.string().optional(),
        body: z.string().optional().describe('Plain-text body; replaces the whole body'),
      },
      // It overwrites the draft and can change who it goes to when sent, so it needs confirming.
      DESTRUCTIVE,
      async (args) => {
        const { message } = await gmail(args, 'GET', `${draftPath(args.draft_id)}?format=full`);
        const current = recipients(message);
        const raw = rawMessage({
          // Gmail sends from a send-as alias only if it's in From, so From and Reply-To are kept.
          from: header(message, 'From'),
          replyTo: header(message, 'Reply-To'),
          to: args.to ?? current.to,
          cc: args.cc ?? current.cc,
          bcc: args.bcc ?? current.bcc,
          subject: args.subject ?? current.subject,
          body: args.body ?? bodyText(message.payload),
          inReplyTo: header(message, 'In-Reply-To'),
          references: header(message, 'References'),
          attachments: await attachmentsOf(args, message),
        });
        const updated = await gmail(args, 'PUT', draftPath(args.draft_id), { message: { raw, threadId: message.threadId } });
        return { draft_id: updated.id, thread_id: updated.message?.threadId };
      },
    );

    tool(
      'mail_send_draft',
      'Send a draft. The approval prompt shows only the draft ID, so first show the user the draft (mail_get_draft).',
      { draft_id: id, account },
      DESTRUCTIVE,
      async (args) => {
        const { message } = await gmail(args, 'GET', `${draftPath(args.draft_id)}?format=metadata`);
        const sent = await gmail(args, 'POST', '/drafts/send', { id: args.draft_id });
        return { message_id: sent.id, thread_id: sent.threadId, ...recipients(message) };
      },
    );

    tool('mail_delete_draft', 'Permanently delete a draft. It does not go to Trash.', { draft_id: id, account }, DESTRUCTIVE, async (args) => {
      await gmail(args, 'DELETE', draftPath(args.draft_id));
      return { ok: true };
    });

    tool(
      'mail_forward_message',
      'Forward a message, including its attachments, to new recipients. The forward stays in the original thread.',
      {
        account,
        message_id: id.describe('Message ID to forward'),
        to: z.string().describe('Comma-separated recipients'),
        cc: z.string().optional(),
        bcc: z.string().optional(),
        body: z.string().default('').describe('Plain-text note above the forwarded message'),
      },
      DESTRUCTIVE,
      async (args) => {
        const orig = await gmail(args, 'GET', `/messages/${encodeURIComponent(args.message_id)}?format=full`);
        const attachments = await attachmentsOf(args, orig);
        const subject = header(orig, 'Subject') ?? '';
        const messageId = header(orig, 'Message-ID');
        const quoted = ['From', 'Date', 'Subject', 'To', 'Cc'].filter((h) => header(orig, h)).map((h) => `${h}: ${header(orig, h)}`);
        const raw = rawMessage({
          to: args.to,
          cc: args.cc,
          bcc: args.bcc,
          subject: /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`,
          body: [args.body, '', '---------- Forwarded message ---------', ...quoted, '', bodyText(orig.payload)].join('\n').trimStart(),
          inReplyTo: messageId,
          references: [header(orig, 'References'), messageId].filter(Boolean).join(' '),
          attachments,
        });
        const sent = await gmail(args, 'POST', '/messages/send', { raw, threadId: orig.threadId });
        return { message_id: sent.id, thread_id: sent.threadId, to: args.to, cc: args.cc, bcc: args.bcc, attachments: attachments.map((a) => a.filename) };
      },
    );

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
