/**
 * ee-migrate: translate a site's netlify.toml into _redirects and _headers
 * (#938), and its build settings into a GitHub Actions deploy workflow
 * (#939).
 *
 * The translation is ee-builder's (-migrate), decided on #935, so the rules
 * it writes are checked by the same validator a deploy uses. This downloads
 * ee-builder the way ee-deploy does and runs it; ee-builder prints the
 * summary and writes the files and the JSON report.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { DEFAULT_CONTROL_PLANE, builderEnv, builderFlags, ensureBuilder, lockedDigest } from './builder.js';
import { defaultCacheDir } from './deploy.js';

/** The ee-builder flags ee-migrate always needs. All came with -migrate (#951). */
export const MIGRATE_FLAGS = ['-migrate', '-migrate-report', '-migrate-redirects', '-migrate-headers', '-strict'];

/**
 * The deploy workflow's flags (#939), which came later. One is needed only
 * when its option is given, except -migrate-no-workflow: a builder without
 * it writes no workflow anyway, so it is then left out.
 */
export const WORKFLOW_FLAGS = ['-migrate-no-workflow', '-migrate-workflow', '-migrate-domain', '-migrate-project', '-migrate-secret', '-migrate-plain'];

/**
 * Set for ee-builder so its messages name ee-migrate's options (--workflow)
 * rather than its own flags (-migrate-workflow).
 */
export const MIGRATE_CLI_ENV = 'EE_MIGRATE_CLI';

const abs = (p) => (isAbsolute(p) ? p : resolve(process.cwd(), p));

/** The arguments for one ee-builder -migrate run. Paths are made absolute. */
export function migrateArgs({
  dir, strict = false, report = null, redirects = null, headers = null,
  noWorkflow = false, workflow = null, domain = null, project = null, secret = [], plain = [],
}) {
  const args = ['-migrate', abs(dir)];
  if (report) args.push('-migrate-report', abs(report));
  if (redirects) args.push('-migrate-redirects', abs(redirects));
  if (headers) args.push('-migrate-headers', abs(headers));
  if (noWorkflow) args.push('-migrate-no-workflow');
  if (workflow) args.push('-migrate-workflow', abs(workflow));
  if (domain) args.push('-migrate-domain', domain);
  if (project) args.push('-migrate-project', project);
  for (const n of secret) args.push('-migrate-secret', n);
  for (const n of plain) args.push('-migrate-plain', n);
  if (strict) args.push('-strict');
  return args;
}

/** The workflow flags these options need the builder to have. */
function workflowFlagsUsed({ workflow, domain, project, secret = [], plain = [] }) {
  return [
    workflow && '-migrate-workflow',
    domain && '-migrate-domain',
    project && '-migrate-project',
    secret.length && '-migrate-secret',
    plain.length && '-migrate-plain',
  ].filter(Boolean);
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
  noWorkflow = false,
  workflow = null,
  domain = null,
  project = null,
  secret = [],
  plain = [],
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

  // Read before ensureBuilder, which pins whatever it uses on a first run:
  // what matters for the hint is whether the lockfile already chose it.
  const pinnedLatest = !builderPath && builderVersion === 'latest' && !builderChecksum && Boolean(lockedDigest(lockfilePath, 'latest'));

  // ensureBuilder pins the builder it uses in the lockfile. If this run then
  // refuses that builder, the pin is put back as it was, so a failed
  // ee-migrate never leaves ee-migrate or ee-deploy held to it (#966).
  const lock = lockfilePath && !builderPath ? abs(lockfilePath) : null;
  const lockBefore = lock && existsSync(lock) ? readFileSync(lock) : null;
  const restoreLock = () => {
    if (!lock) return false;
    const now = existsSync(lock) ? readFileSync(lock) : null;
    if (lockBefore ? now && now.equals(lockBefore) : !now) return false;
    if (lockBefore) writeFileSync(lock, lockBefore);
    else rmSync(lock, { force: true });
    return true;
  };

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
  let have;
  try {
    have = builderFlags(bin, [...MIGRATE_FLAGS, ...WORKFLOW_FLAGS]);
  } catch (err) {
    restoreLock();
    throw err;
  }
  const missing = MIGRATE_FLAGS.filter((f) => !have.includes(f));
  const missingWorkflow = workflowFlagsUsed({ workflow, domain, project, secret, plain }).filter((f) => !have.includes(f));
  if (missingWorkflow.length && !missing.length) {
    const undone = restoreLock() ? ` ${lockfilePath} is back as it was before this run; don't commit the pin it printed.` : '';
    throw new Error(`ee-builder at ${bin} predates the deploy workflow: it has no ${missingWorkflow.join(', ')}, so it ` +
      `can't take ${missingWorkflow.map((f) => f.replace('-migrate-', '--')).join(', ')}. Use a newer ee-builder, or leave ` +
      `those options out: this one writes no workflow.${undone}`);
  }
  if (missing.length) {
    // ee-builder was first published with -migrate on 2026-11-10. The hint
    // names whatever chose this builder.
    let hint;
    if (builderPath) {
      hint = 'Rebuild it from the current ee-cdn source (go build -tags nodynamic in ee-builder) and pass that with --builder.';
    } else if (builderVersion !== 'latest') {
      hint = `ee-builder ${builderVersion} was published before it; use "latest" or a label from 2026-11-10 or later with --builder-version.`;
    } else if (builderChecksum) {
      hint = 'The checksum given pins an ee-builder from before it.';
    } else if (pinnedLatest) {
      hint = `${lockfilePath} pins an older ee-builder latest: delete its "latest:" entry so the current release is fetched.`;
    } else {
      hint = 'The latest ee-builder it found, downloaded or cached, predates it. Run again with a working connection so the ' +
        'current release is fetched, or pass a newer one with --builder.';
    }
    const undone = restoreLock() ? ` ${lockfilePath} is back as it was before this run; don't commit the pin it printed.` : '';
    throw new Error(`ee-builder at ${bin} is too old to migrate: it has no ${missing.join(', ')}. ${hint}${undone}`);
  }

  const args = migrateArgs({
    dir: src, strict, report, redirects, headers,
    noWorkflow: noWorkflow && have.includes('-migrate-no-workflow'),
    workflow, domain, project, secret, plain,
  });
  const r = spawnSync(bin, args, {
    env: { ...builderEnv(), [MIGRATE_CLI_ENV]: '1' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (r.error) throw new Error(`Could not run ee-builder at ${bin}: ${r.error.message}`);
  if (r.signal) throw new Error(`ee-builder was killed by ${r.signal}`);
  return r.status;
}
