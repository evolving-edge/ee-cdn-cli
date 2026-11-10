/**
 * ee-migrate: translate a site's netlify.toml into _redirects and _headers
 * (#938).
 *
 * The translation is ee-builder's (-migrate), decided on #935, so the rules
 * it writes are checked by the same validator a deploy uses. This downloads
 * ee-builder the way ee-deploy does and runs it; ee-builder prints the
 * summary and writes the files and the JSON report.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { DEFAULT_CONTROL_PLANE, builderEnv, builderFlags, ensureBuilder } from './builder.js';
import { defaultCacheDir } from './deploy.js';

/** The ee-builder flags ee-migrate passes. All came with -migrate (#951). */
export const MIGRATE_FLAGS = ['-migrate', '-migrate-report', '-migrate-redirects', '-migrate-headers', '-strict'];

const abs = (p) => (isAbsolute(p) ? p : resolve(process.cwd(), p));

/** The arguments for one ee-builder -migrate run. Paths are made absolute. */
export function migrateArgs({ dir, strict = false, report = null, redirects = null, headers = null }) {
  const args = ['-migrate', abs(dir)];
  if (report) args.push('-migrate-report', abs(report));
  if (redirects) args.push('-migrate-redirects', abs(redirects));
  if (headers) args.push('-migrate-headers', abs(headers));
  if (strict) args.push('-strict');
  return args;
}

/**
 * Run the translation. Returns ee-builder's exit status: 0 when the files and
 * the report were written, 1 when it stopped (no netlify.toml, a malformed
 * one) or, with strict, when a setting was dropped.
 */
export async function migrateSite({
  dir = '.',
  strict = false,
  report = null,
  redirects = null,
  headers = null,
  controlPlane = DEFAULT_CONTROL_PLANE,
  builderPath = null,
  builderVersion = 'latest',
  builderChecksum = null,
  lockfilePath = null,
  cacheDir = defaultCacheDir(),
  logger = console,
}) {
  const src = abs(dir);
  if (!existsSync(src) || !statSync(src).isDirectory()) {
    throw new Error(`Not a directory: ${src}`);
  }

  let bin;
  if (builderPath) {
    bin = abs(builderPath);
    if (!existsSync(bin)) throw new Error(`builderPath does not exist: ${bin}`);
  } else {
    mkdirSync(cacheDir, { recursive: true });
    bin = await ensureBuilder({ controlPlane, version: builderVersion, checksum: builderChecksum, lockfilePath, cacheDir, logger });
  }

  // A builder from before -migrate would stop with a usage error that names
  // none of this.
  const have = builderFlags(bin, MIGRATE_FLAGS);
  const missing = MIGRATE_FLAGS.filter((f) => !have.includes(f));
  if (missing.length) {
    // ee-builder was first published with -migrate on 2026-11-10.
    const hint = builderPath
      ? 'Rebuild it from the current ee-cdn source (go build -tags nodynamic in ee-builder) and pass that with --builder.'
      : builderVersion !== 'latest'
        ? `ee-builder ${builderVersion} was published before it; use "latest" or a label from 2026-11-10 or later with --builder-version.`
        : `${lockfilePath ?? 'Your lockfile'} pins an older ee-builder latest: delete its "latest:" entry so the current ` +
          'release is fetched.';
    throw new Error(`ee-builder at ${bin} is too old to migrate: it has no ${missing.join(', ')}. ${hint}`);
  }

  const r = spawnSync(bin, migrateArgs({ dir: src, strict, report, redirects, headers }), {
    env: builderEnv(),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (r.error) throw new Error(`Could not run ee-builder at ${bin}: ${r.error.message}`);
  if (r.signal) throw new Error(`ee-builder was killed by ${r.signal}`);
  return r.status;
}
