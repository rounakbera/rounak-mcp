// Gmail API message parsing and plain-text RFC 5322 message building.

export const header = (msg, name) =>
  msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

export const parts = (part) => [part, ...(part?.parts ?? []).flatMap(parts)];

const decode = (data) => Buffer.from(data, 'base64url').toString();

export function bodyText(payload) {
  const all = parts(payload);
  const plain = all.find((p) => p.mimeType === 'text/plain' && p.body?.data);
  if (plain) return decode(plain.body.data);
  const html = all.find((p) => p.mimeType === 'text/html' && p.body?.data);
  return html ? decode(html.body.data).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

// Returns the base64url `raw` value the Gmail API expects.
export function rawMessage({ to, cc, bcc, subject, body, inReplyTo, references }) {
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
    'Content-Type': 'text/plain; charset=UTF-8',
    'Content-Transfer-Encoding': 'base64',
  }).filter(([, v]) => v);
  const encodedBody = Buffer.from(body).toString('base64').replace(/.{76}/g, '$&\r\n');
  return Buffer.from(`${headers.map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${encodedBody}`).toString('base64url');
}
