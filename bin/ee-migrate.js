#!/usr/bin/env node
/**
 * ee-migrate — translate a site's netlify.toml into the _redirects and
 * _headers files Evolving Edge reads (#938), and its build settings into a
 * GitHub Actions deploy workflow (#939).
 *
 *   ee-migrate ./my-site
 *
 * Runs ee-builder -migrate, downloading ee-builder as ee-deploy does.
 */
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

import { DEFAULT_CONTROL_PLANE } from '../src/builder.js';
import { migrateSite } from '../src/migrate.js';

const { version } = createRequire(import.meta.url)('../package.json');

const USAGE = `
ee-migrate — move a site's Netlify settings to Evolving Edge

USAGE
  ee-migrate [folder] [options]

  Reads netlify.toml in [folder] (default: the current folder) and writes
  _redirects and _headers for it. Prints what was carried over, what was
  dropped and why, and what is left for you to do, and writes the same as
  JSON to ee-migrate-report.json. A site that already has _redirects or
  _headers keeps its own rules; the translated ones are added after them.
  Running it again replaces what it added.

  It also writes the build settings as a GitHub Actions workflow,
  .github/workflows/ee-deploy.yml at the root of the git repository holding
  [folder], that builds the site and deploys it on every push. Build
  environment variables that look like credentials are read from repository
  secrets; their values are never written or printed. A workflow file that
  ee-migrate didn't write for this site, or that has been edited since, is
  never replaced.

OPTIONS
  --strict               Exit 1 if any setting was dropped. Settings handled
                         elsewhere, such as build settings with
                         --no-workflow, don't count
  --report <path>        Where to write the JSON report. Default
                         ee-migrate-report.json in [folder], or a temporary
                         file when that would be inside the deploy folder
  --redirects <path>     The existing _redirects to add the rules to, when
                         the site has more than one
  --headers <path>       The existing _headers to add the rules to, when the
                         site has more than one
  --no-workflow          Don't write the deploy workflow
  --workflow <path>      Where to write the deploy workflow instead
  --domain <domain>      Write this domain into the workflow instead of
                         reading the EE_CDN_DOMAIN repository variable
  --project <id>         Write this project ID into the workflow instead of
                         reading the EE_CDN_PROJECT_ID repository variable
  --secret <NAME>        Read this build environment variable from a
                         repository secret, whatever it looks like. Repeatable
  --plain <NAME>         Write this build environment variable's value into
                         the workflow, even if it looks like a credential.
                         Repeatable
  --builder <path>       Use a local ee-builder instead of downloading one
  --builder-version <v>  Pin the ee-builder version instead of "latest".
                         Defaults to $EE_BUILDER_VERSION
  --lockfile <path>      Builder checksum lockfile. Default .ee-builder-lock.json
  --cache-dir <path>     Where to keep the downloaded ee-builder.
                         Default $XDG_CACHE_HOME/evolving-edge or ~/.cache/evolving-edge
  --control-plane <url>  Default ${DEFAULT_CONTROL_PLANE}
  --quiet, -q            Don't print download progress
  --version, -v
  --help, -h

EXIT STATUS
  0  The files and the report were written, even if settings were dropped
  1  Nothing was written (no netlify.toml, one that doesn't parse, or a
     workflow file ee-migrate can't replace is in the way), or --strict and
     a setting was dropped
  2  A usage error

EXAMPLES
  ee-migrate
  ee-migrate ./my-site --strict
  ee-migrate ./my-site --domain www.example.com --secret ALGOLIA_APP_ID
  ee-migrate ./my-site --no-workflow
`;

function fail(message, { usage = false, code = 2 } = {}) {
  console.error(`ee-migrate: ${message}`);
  if (usage) console.error('\nRun `ee-migrate --help` for usage.');
  process.exit(code);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      strict: { type: 'boolean', default: false },
      report: { type: 'string' },
      redirects: { type: 'string' },
      headers: { type: 'string' },
      'no-workflow': { type: 'boolean', default: false },
      workflow: { type: 'string' },
      domain: { type: 'string' },
      project: { type: 'string' },
      secret: { type: 'string', multiple: true },
      plain: { type: 'string', multiple: true },
      builder: { type: 'string' },
      'builder-version': { type: 'string' },
      lockfile: { type: 'string' },
      'cache-dir': { type: 'string' },
      'control-plane': { type: 'string' },
      quiet: { type: 'boolean', short: 'q', default: false },
      version: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
} catch (err) {
  fail(err.message, { usage: true });
}

const { values: opts, positionals } = parsed;

if (opts.help) {
  console.log(USAGE.trim());
  process.exit(0);
}
if (opts.version) {
  console.log(version);
  process.exit(0);
}
if (positionals.length > 1) {
  fail(`expected one folder, got ${positionals.length}: ${positionals.join(', ')}`, { usage: true });
}

const logger = opts.quiet
  ? { info() {}, warn: console.warn }
  : { info: (m) => console.log(m), warn: (m) => console.warn(m) };

try {
  const status = await migrateSite({
    dir: positionals[0] ?? '.',
    strict: opts.strict,
    report: opts.report ?? null,
    redirects: opts.redirects ?? null,
    headers: opts.headers ?? null,
    noWorkflow: opts['no-workflow'],
    workflow: opts.workflow ?? null,
    domain: opts.domain ?? null,
    project: opts.project ?? null,
    secret: opts.secret ?? [],
    plain: opts.plain ?? [],
    builderPath: opts.builder ?? null,
    builderVersion: opts['builder-version'] ?? process.env.EE_BUILDER_VERSION ?? 'latest',
    lockfilePath: opts.lockfile ?? '.ee-builder-lock.json',
    controlPlane: opts['control-plane'] ?? DEFAULT_CONTROL_PLANE,
    ...(opts['cache-dir'] ? { cacheDir: opts['cache-dir'] } : {}),
    logger,
  });
  process.exit(status);
} catch (err) {
  fail(err.message, { code: 1 });
}
