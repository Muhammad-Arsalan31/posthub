export type Bump = 'major' | 'minor' | 'patch';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Parses a plain `MAJOR.MINOR.PATCH` version (no pre-release or build suffix). */
export function parseVersion(version: string): [number, number, number] {
  const match = SEMVER.exec(version);
  if (!match) throw new Error(`"${version}" is not a MAJOR.MINOR.PATCH version.`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a: string, b: string): number {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) {
    const diff = x[i]! - y[i]!;
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/** The version after `current`, from a bump keyword or an explicit higher version. */
export function nextVersion(current: string, target: Bump | (string & {})): string {
  const [major, minor, patch] = parseVersion(current);
  switch (target) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    default:
      if (compareVersions(target, current) <= 0) {
        throw new Error(`${target} must be higher than the current version ${current}.`);
      }
      return target;
  }
}
