import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';

/**
 * AES-256-GCM encryption for platform credentials at rest.
 * The key comes from POSTHUB_ENCRYPTION_KEY. Changing it makes stored credentials unreadable,
 * so every account would need to reconnect.
 */
export function createVault(secret: string) {
  if (secret.length < 32) throw new Error('Encryption key must be at least 32 characters');
  const key = createHash('sha256').update(secret).digest();

  return {
    encrypt(value: unknown): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return [VERSION, iv, cipher.getAuthTag(), data]
        .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
        .join('.');
    },

    decrypt<T = unknown>(payload: string): T {
      const [version, iv, tag, data] = payload.split('.');
      if (version !== VERSION || !iv || !tag || !data)
        throw new Error('Unrecognized credential format');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      const json = Buffer.concat([
        decipher.update(Buffer.from(data, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
      return JSON.parse(json) as T;
    },
  };
}

export type Vault = ReturnType<typeof createVault>;
