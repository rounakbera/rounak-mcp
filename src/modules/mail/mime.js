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

export function bodyText(payload) {
  const all = parts(payload);
  const plain = all.find((p) => p.mimeType === 'text/plain' && p.body?.data);
  if (plain) return decode(plain.body.data);
  const html = all.find((p) => p.mimeType === 'text/html' && p.body?.data);
  return html ? decode(html.body.data).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

const base64Lines = (buf) => buf.toString('base64').replace(/.{76}/g, '$&\r\n');

// Filename and type come from the original sender, so they're reduced to safe header values.
function attachmentPart({ filename, mimeType, data }) {
  // message/* and multipart/* parts can't be base64-encoded, so they go as opaque files.
  const type = /^(?!message\/|multipart\/)[\w.+-]+\/[\w.+-]+$/i.test(mimeType ?? '') ? mimeType : 'application/octet-stream';
  const name = filename.slice(0, 200).toWellFormed().replace(/[\x00-\x1f\x7f"\\]/g, '_');
  const param = /^[\x20-\x7e]*$/.test(name) ? `filename="${name}"` : `filename*=UTF-8''${encodeURIComponent(name)}`;
  return [`Content-Type: ${type}`, `Content-Disposition: attachment; ${param}`, 'Content-Transfer-Encoding: base64', '', base64Lines(data)].join('\r\n');
}

// Returns the base64url `raw` value the Gmail API expects: plain text, or multipart/mixed with attachments.
export function rawMessage({ to, cc, bcc, subject, body, inReplyTo, references, attachments = [] }) {
  if ([to, cc, bcc, subject, inReplyTo, references].some((v) => /[\r\n]/.test(v ?? ''))) {
    throw new Error('Header values must not contain line breaks');
  }
  const headers = Object.entries({
    To: to,
    Cc: cc,
    Bcc: bcc,
    Subject: subject && (/^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`),
    'In-Reply-To': inReplyTo,
    References: references,
    'MIME-Version': '1.0',
  }).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  const text = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64Lines(Buffer.from(body))].join('\r\n');
  let message;
  if (attachments.length) {
    // Every part is base64, so the boundary can't appear inside one.
    const boundary = `=_${randomBytes(16).toString('hex')}`;
    const partsText = [text, ...attachments.map(attachmentPart)].map((p) => `--${boundary}\r\n${p}\r\n`).join('');
    message = `${headers.join('\r\n')}\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${partsText}--${boundary}--\r\n`;
  } else {
    message = `${headers.join('\r\n')}\r\n${text}`;
  }
  return Buffer.from(message).toString('base64url');
}
