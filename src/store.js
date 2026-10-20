import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// AES-256-GCM encrypted JSON file. Read on every access, so the server sees `npm run link` changes.
export class Store {
  constructor(dataDir, key) {
    this.key = key;
    this.path = join(dataDir, 'state.enc');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }

  read() {
    let buf;
    try {
      buf = readFileSync(this.path);
    } catch (e) {
      if (e.code === 'ENOENT') return { accounts: {}, refreshTokens: {} };
      throw e;
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString());
  }

  update(fn) {
    const data = this.read();
    const result = fn(data);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
    writeFileSync(`${this.path}.tmp`, Buffer.concat([iv, cipher.getAuthTag(), body]), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
    return result;
  }
}
