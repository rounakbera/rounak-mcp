// Gmail API message parsing and RFC 5322 message building.
import { randomBytes } from 'node:crypto';

export const header = (msg, name) =>
  msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

export const parts = (part) => [part, ...(part?.parts ?? []).flatMap(parts)];

// Gmail returns snippets HTML-escaped.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const unescapeHtml = (s) =>
  s?.replace(/&(#\d+|[a-z]+);/g, (m, e) => (e[0] === '#' ? String.fromCodePoint(Number(e.slice(1))) : ENTITIES[e] ?? m));

const decode = (data) => Buffer.from(data, 'base64url').toString();

// The decoded text of a message's first `text/plain` or `text/html` part.
export function partText(payload, mimeType) {
  const part = parts(payload).find((p) => p.mimeType === mimeType && p.body?.data);
  return part && decode(part.body.data);
}

// Plain text from HTML, keeping its line and paragraph breaks.
export const htmlText = (html) =>
  unescapeHtml(
    html
      .replace(/<(style|script)[^>]*>[^]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d|blockquote)>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export function bodyText(payload) {
  const plain = partText(payload, 'text/plain');
  if (plain) return plain;
  const html = partText(payload, 'text/html');
  return html ? html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

// A draft's text. Gmail hard-wraps the plain-text copy of drafts written in Gmail, so the HTML is
// preferred: text taken from the plain copy and sent again would keep those breaks.
export function draftText(payload) {
  const html = partText(payload, 'text/html');
  return html ? htmlText(html) : (partText(payload, 'text/plain') ?? '');
}

const base64Lines = (buf) => buf.toString('base64').replace(/.{76}/g, '$&\r\n');

// Filename and type come from the original sender, so they're reduced to safe header values.
// A valid Content-ID is kept so inline images still show in the HTML that refers to them.
function attachmentPart({ filename, mimeType, contentId, data }) {
  // message/* and multipart/* parts can't be base64-encoded, so they go as opaque files.
  const type = /^(?!message\/|multipart\/)[\w.+-]+\/[\w.+-]+$/i.test(mimeType ?? '') ? mimeType : 'application/octet-stream';
  const name = filename.slice(0, 200).toWellFormed().replace(/[\x00-\x1f\x7f"\\]/g, '_');
  const param = /^[\x20-\x7e]*$/.test(name) ? `filename="${name}"` : `filename*=UTF-8''${encodeURIComponent(name)}`;
  const cid = /^<[\x21-\x3b\x3d\x3f-\x7e]{1,200}>$/.test(contentId ?? '') && contentId;
  return [
    `Content-Type: ${type}`,
    `Content-Disposition: ${cid ? 'inline' : 'attachment'}; ${param}`,
    ...(cid ? [`Content-ID: ${cid}`] : []),
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(data),
  ].join('\r\n');
}

const textPart = (subtype, text) =>
  [`Content-Type: text/${subtype}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', base64Lines(Buffer.from(text))].join('\r\n');

// Every part is base64, so the random boundary can't appear inside one.
function multipart(subtype, partsText) {
  const boundary = `=_${randomBytes(16).toString('hex')}`;
  return `Content-Type: multipart/${subtype}; boundary="${boundary}"\r\n\r\n${partsText.map((p) => `--${boundary}\r\n${p}\r\n`).join('')}--${boundary}--\r\n`;
}

// Returns the base64url `raw` value the Gmail API expects: plain text, with an HTML alternative
// when `html` is given, in multipart/mixed when there are attachments.
export function rawMessage({ from, replyTo, to, cc, bcc, subject, body, html, inReplyTo, references, attachments = [] }) {
  if ([from, replyTo, to, cc, bcc, subject, inReplyTo, references].some((v) => /[\r\n]/.test(v ?? ''))) {
    throw new Error('Header values must not contain line breaks');
  }
  const headers = Object.entries({
    From: from,
    'Reply-To': replyTo,
    To: to,
    Cc: cc,
    Bcc: bcc,
    Subject: subject && (/^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`),
    'In-Reply-To': inReplyTo,
    References: references,
    'MIME-Version': '1.0',
  }).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  let content = textPart('plain', body);
  if (html) content = multipart('alternative', [content, textPart('html', html)]);
  if (attachments.length) content = multipart('mixed', [content, ...attachments.map(attachmentPart)]);
  return Buffer.from(`${headers.join('\r\n')}\r\n${content}`).toString('base64url');
}
