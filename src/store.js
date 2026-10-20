import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Durable state (linked Google accounts, our refresh tokens) in one AES-256-GCM encrypted file.
export class Store {
  constructor(dataDir, key) {
    this.key = key;
    this.path = join(dataDir, 'state.enc');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.data = this.#load() ?? { accounts: {}, refreshTokens: {} };
  }

  #load() {
    let buf;
    try {
      buf = readFileSync(this.path);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString());
  }

  save() {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(this.data)), cipher.final()]);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, Buffer.concat([iv, cipher.getAuthTag(), body]), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
