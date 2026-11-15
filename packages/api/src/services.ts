// Plain services the API's Effect code depends on. `apiLayer` (layer.ts) provides them all.
import type { Db } from '@posthub/db';
import { Context, Layer } from 'effect';

/** The Drizzle database. */
export class Database extends Context.Service<Database, Db>()('@posthub/api/Database') {
  static readonly layer = (db: Db) => Layer.succeed(Database, db);
}

/** Folder holding uploaded media files. */
export class MediaDir extends Context.Service<MediaDir, string>()('@posthub/api/MediaDir') {
  static readonly layer = (dir: string) => Layer.succeed(MediaDir, dir);
}
