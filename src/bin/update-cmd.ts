/**
 * update-cmd.ts — `fozikio update`.
 *
 * Compares the installed version against the npm registry. Reports only; it
 * never installs, because upgrading a globally-installed package under the
 * user's feet is their decision, not the tool's.
 *
 * The registry is queried over plain fetch rather than by shelling out to
 * `npm view`, which keeps it fast and avoids depending on npm being on PATH.
 */

import { createRequire } from 'node:module';
import { parse } from '../cli/args.js';
import { c } from '../cli/ui/color.js';
import { mark, sym } from '../cli/ui/symbols.js';
import { spin } from '../cli/ui/spinner.js';

const REGISTRY = process.env.npm_config_registry ?? 'https://registry.npmjs.org';

interface PackageStatus {
  name: string;
  installed: string;
  latest?: string;
  outdated: boolean;
  error?: string;
}

/** Installed version of this package, read from its own manifest. */
function installedVersion(): { name: string; version: string } {
  const require = createRequire(import.meta.url);
  const pkg = require('../../package.json') as { name: string; version: string };
  return { name: pkg.name, version: pkg.version };
}

/** Latest published version, via the registry's abbreviated metadata. */
async function latestVersion(name: string): Promise<string> {
  const res = await fetch(`${REGISTRY}/${encodeURIComponent(name)}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`registry returned ${res.status}`);
  const body = await res.json() as { 'dist-tags'?: Record<string, string> };
  const latest = body['dist-tags']?.latest;
  if (!latest) throw new Error('registry response had no latest tag');
  return latest;
}

/** Numeric-aware semver comparison; prerelease tags are ignored. */
function isOlder(a: string, b: string): boolean {
  const parse3 = (v: string) => v.split('-')[0].split('.').map((n) => Number(n) || 0);
  const [x, y] = [parse3(a), parse3(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) < (y[i] ?? 0)) return true;
    if ((x[i] ?? 0) > (y[i] ?? 0)) return false;
  }
  return false;
}

export async function runUpdate(argv: string[]): Promise<void> {
  const parsed = parse(argv);
  const self = installedVersion();

  const spinner = parsed.globals.json ? null : spin('checking npm registry');

  const result: PackageStatus = {
    name: self.name,
    installed: self.version,
    outdated: false,
  };

  try {
    result.latest = await latestVersion(self.name);
    result.outdated = isOlder(self.version, result.latest);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  spinner?.stop();

  if (parsed.globals.json) {
    console.log(JSON.stringify(result, null, 2));
    if (result.outdated) process.exitCode = 1;
    return;
  }

  console.log('');
  if (result.error) {
    console.log(`  ${mark.warn()} ${result.name} ${c.dim(`— could not reach the registry: ${result.error}`)}`);
  } else if (result.outdated) {
    console.log(`  ${mark.warn()} ${result.name} ${c.yellow(result.installed)} ${c.dim(sym.arrow)} ${c.green(result.latest!)}`);
    console.log('');
    console.log(`  ${c.dim(sym.arrow)} ${c.cyan(`npm install -g ${result.name}@latest`)}`);
    process.exitCode = 1;
  } else {
    console.log(`  ${mark.ok()} ${result.name} ${c.dim(result.installed)} ${c.dim('is current')}`);
  }
  console.log('');
}
