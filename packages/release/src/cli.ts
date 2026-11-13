// `pnpm release <patch|minor|major|x.y.z> [--dry-run]`: bump the app version, commit and tag it.
// Pushing the tag runs .github/workflows/release.yml, which publishes the GitHub release.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nextVersion } from './semver';

const RELEASE_BRANCH = 'main';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

/** Root package.json plus every workspace package; they all share the app version. */
function packageFiles() {
  const files = ['package.json'];
  for (const dir of ['apps', 'packages']) {
    for (const name of readdirSync(join(root, dir))) {
      const file = join(dir, name, 'package.json');
      if (existsSync(join(root, file))) files.push(file);
    }
  }
  return files;
}

function release(target: string, dryRun: boolean) {
  if (!dryRun) {
    const branch = git('branch', '--show-current');
    if (branch !== RELEASE_BRANCH) {
      throw new Error(`Releases are cut from ${RELEASE_BRANCH}; you are on ${branch}.`);
    }
    if (git('status', '--porcelain')) {
      throw new Error('The working tree has uncommitted changes. Commit or stash them first.');
    }
  }

  const { version: current } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version: string;
  };
  const version = nextVersion(current, target);
  const tag = `v${version}`;
  if (git('tag', '--list', tag)) throw new Error(`Tag ${tag} already exists.`);

  const previous = git('tag', '--list', 'v*', '--sort=-v:refname').split('\n')[0];
  const log = git('log', '--format=- %s', previous ? `${previous}..HEAD` : 'HEAD');
  console.log(`${current} -> ${version}\n\nCommits since ${previous || 'the start'}:\n${log}\n`);
  if (dryRun) {
    console.log('Dry run: nothing was written.');
    return;
  }

  const files = packageFiles();
  for (const file of files) {
    const path = join(root, file);
    // Replace in place so the file's formatting is untouched.
    const source = readFileSync(path, 'utf8');
    writeFileSync(path, source.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`));
  }
  git('add', ...files);
  git('commit', '-m', `Release ${tag}`);
  git('tag', '-a', tag, '-m', `PostHub ${tag}`);
  console.log(`Committed and tagged ${tag}. Publish the GitHub release with:`);
  console.log('  git push --follow-tags');
}

const args = process.argv.slice(2);
const [target] = args.filter((a) => a !== '--dry-run');
if (!target) {
  console.log('Usage: pnpm release <patch|minor|major|x.y.z> [--dry-run]');
  process.exitCode = 1;
} else {
  try {
    release(target, args.includes('--dry-run'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
