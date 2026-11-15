import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Context, Effect, Layer, Schema } from 'effect';

const VERSION = 'v1';

/** Stored credentials could not be read: tampered, or encrypted with a different key. */
export class VaultError extends Schema.TaggedError<VaultError>()('VaultError', {
  message: Schema.String,
}) {}

export interface VaultService {
  encrypt(value: unknown): string;
  decrypt<T = unknown>(payload: string): Effect.Effect<T, VaultError>;
}

/**
 * AES-256-GCM encryption for platform credentials at rest.
 * The key comes from POSTHUB_ENCRYPTION_KEY. Changing it makes stored credentials unreadable,
 * so every account would need to reconnect. Throws on a short key: that is a startup config error.
 */
export function createVault(secret: string): VaultService {
  if (secret.length < 32) throw new Error('Encryption key must be at least 32 characters');
  const key = createHash('sha256').update(secret).digest();

  return {
    encrypt(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return [VERSION, iv, cipher.getAuthTag(), data]
        .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
        .join('.');
    },

    decrypt: <T>(payload: string) =>
      Effect.try({
        try: () => {
          const [version, iv, tag, data] = payload.split('.');
          if (version !== VERSION || !iv || !tag || !data) {
            throw new Error('Unrecognized credential format');
          }
          const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
          decipher.setAuthTag(Buffer.from(tag, 'base64url'));
          const json = Buffer.concat([
            decipher.update(Buffer.from(data, 'base64url')),
            decipher.final(),
          ]).toString('utf8');
          return JSON.parse(json) as T;
        },
        catch: (cause) =>
          new VaultError({
            message: `Stored credentials could not be decrypted (${cause instanceof Error ? cause.message : String(cause)}). Was the encryption key changed?`,
          }),
      }),
  };
}

export class Vault extends Context.Service<Vault, VaultService>()('@posthub/integrations/Vault') {
  static readonly layer = (secret: string) => Layer.sync(Vault, () => createVault(secret));
}
