// The app version comes from the root package.json, which `pnpm release` bumps.
import { repository, version } from '../../../../package.json';

export const APP_VERSION = version;

/** Release notes for the running version, on GitHub. */
export const RELEASE_NOTES_URL = `${repository.url}/releases/tag/v${version}`;
