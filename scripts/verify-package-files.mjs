/**
 * Publish preflight — every `files` entry must resolve to something.
 *
 * WHY THIS EXISTS. `npm publish` does not error on a `files` entry that is
 * absent from the working tree; it silently omits it. That is how the web
 * dashboard stopped shipping. `public/` is a build artefact from a separate
 * repository, so it existed on disk while publishing was done by hand, and has
 * never existed on a fresh `actions/checkout`. The move to OIDC publishing in
 * 1.2.2 therefore dropped it from the tarball, and four releases went out
 * without it — each one green, each one reporting success.
 *
 * The failure was invisible because nothing ever compared what `files`
 * promises against what the tree can actually deliver. This does, and it
 * covers every entry, not the one that already broke: `hooks`, `skills`,
 * `reflex-rules` and `scripts/nli-service` can all vanish from a tarball the
 * same way, and today the only way to find out would be a user reporting it
 * against a published version.
 *
 * ORDERING. `dist` only exists after a build, so this runs AFTER `npm run
 * build` and before `npm publish`.
 *
 * Usage:
 *   npm run verify:package
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const entries = pkg.files ?? [];

if (entries.length === 0) {
  console.error('package.json declares no `files` array — nothing to verify.');
  process.exit(1);
}

/**
 * A glob is left to npm: resolving one faithfully here would mean
 * reimplementing npm's matching rules, and a check that disagrees with the
 * packer is worse than no check. Reported so a skip is never silent — the
 * whole point of this script is that omissions get said out loud.
 */
const isGlob = (entry) => /[*?[\]{}!]/.test(entry);

const missing = [];
const empty = [];
const skipped = [];

for (const entry of entries) {
  if (isGlob(entry)) {
    skipped.push(entry);
    continue;
  }

  const target = join(root, entry);
  if (!existsSync(target)) {
    missing.push(entry);
    continue;
  }

  // A directory that exists but holds nothing packs to nothing, which is the
  // same outcome as its being absent.
  if (statSync(target).isDirectory() && readdirSync(target).length === 0) {
    empty.push(entry);
  }
}

for (const entry of skipped) {
  console.log(`skipped (glob, left to npm): ${entry}`);
}

if (missing.length === 0 && empty.length === 0) {
  const checked = entries.length - skipped.length;
  console.log(`All ${checked} literal \`files\` entries resolve. Safe to publish.`);
  process.exit(0);
}

console.error('\npackage.json `files` promises paths this tree cannot deliver:\n');
for (const entry of missing) console.error(`  missing:            ${entry}`);
for (const entry of empty) console.error(`  present but empty:  ${entry}`);
console.error(
  '\nnpm would omit these from the tarball without failing the publish.\n' +
    'Either produce them before packing, or drop them from `files`.\n',
);
process.exit(1);
