#!/usr/bin/env node
/**
 * ee-deploy — publish any directory of static files to the Evolving Edge CDN.
 *
 * Framework-agnostic by design. Astro has an integration; everything else —
 * Hugo, Eleventy, Jekyll, Zola, Publii, hand-written HTML — comes through here:
 *
 *   ee-deploy ./public --domain blog.example.com --project proj_abc
 *
 * Publii specifically: set deployment to "Manual", which writes the site to a
 * folder, then point this at that folder.
 */
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

import { deploySite } from '../src/deploy.js';
import { DEFAULT_CONTROL_PLANE } from '../src/builder.js';
import { detectOutputDir } from '../src/detect.js';

const { version } = createRequire(import.meta.url)('../package.json');

const USAGE = `
ee-deploy — publish a directory to the Evolving Edge CDN

USAGE
  ee-deploy [directory] --domain <host> [options]

REQUIRED
  --domain, -d <host>    Hostname the edge serves this workload as

DIRECTORY
  [directory]            Built site to publish (e.g. ./public, ./dist, ./_site).
                         Optional: without it, the output folder is detected
                         from the project (Astro, Next.js static export, Nuxt,
                         SvelteKit, Docusaurus, VitePress, Gatsby, Hexo,
                         Eleventy, Hugo, Jekyll, MkDocs, mdBook, Sphinx, Zola,
                         Vite). Nothing is guessed: if detection is unsure,
                         it says what it found and asks.

OPTIONS
  --project <id>         Project ID (proj_…). Required if your token is
                         project-scoped, which it should be.
  --name <name>          Workload name. Defaults to the domain.
  --level <0|1|2>        Encryption level. Default 0 (public static site).
  --token <token>        Deploy token. Defaults to $EE_CDN_TOKEN.
  --control-plane <url>  Default ${DEFAULT_CONTROL_PLANE}
  --build <id>           Build config ID, for server-side defaults
  --org <id>             Organisation ID
  --trailing-slash       Redirect /about to /about/ (writes "# ee:trailing-slash on"
                         into _redirects; the site's own setting wins)
  --clean-urls           Serve /about from about.html (writes "# ee:clean-urls on")
  --builder <path>       Use a local ee-builder instead of downloading one
  --builder-version <v>  Pin the ee-builder version instead of "latest".
                         Defaults to $EE_BUILDER_VERSION
  --lockfile <path>      Builder checksum lockfile. Default .ee-builder-lock.json
  --cache-dir <path>     Where to keep the downloaded ee-builder.
                         Default $XDG_CACHE_HOME/evolving-edge or ~/.cache/evolving-edge
  --dry-run              Package but do not upload; leaves the .ee on disk
  --quiet, -q            Errors only
  --version, -v
  --help, -h

ENVIRONMENT
  EE_CDN_TOKEN           Deploy token, from the portal (Workload → Deploy Tokens)
  EE_CDN_PROJECT_ID      Default for --project
  EE_CDN_BUILD_ID        Default for --build
  EE_BUILDER_VERSION     Default for --builder-version

EXAMPLES
  ee-deploy ./public --domain blog.example.com --project proj_abc
  ee-deploy ./_site  --domain example.com --dry-run
`;

function fail(message, { usage = false } = {}) {
  console.error(`ee-deploy: ${message}`);
  if (usage) console.error('\nRun `ee-deploy --help` for usage.');
  process.exit(2);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      domain: { type: 'string', short: 'd' },
      project: { type: 'string' },
      name: { type: 'string' },
      level: { type: 'string' },
      token: { type: 'string' },
      'control-plane': { type: 'string' },
      build: { type: 'string' },
      org: { type: 'string' },
      builder: { type: 'string' },
      'builder-version': { type: 'string' },
      'trailing-slash': { type: 'boolean', default: false },
      'clean-urls': { type: 'boolean', default: false },
      lockfile: { type: 'string' },
      'cache-dir': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
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

let dir = positionals[0];
if (positionals.length === 0) {
  try {
    const found = detectOutputDir(process.cwd());
    dir = found.dir;
    console.log(`Deploying ./${found.rel} (detected: ${found.label})`);
  } catch (err) {
    fail(err.message);
  }
}
if (positionals.length > 1) {
  fail(`expected one directory, got ${positionals.length}: ${positionals.join(', ')}`);
}

const domain = opts.domain;
if (!domain) fail('--domain is required — it is what the edge serves this workload as', { usage: true });

const level = opts.level === undefined ? 0 : Number(opts.level);
if (!Number.isInteger(level) || level < 0 || level > 2) {
  fail(`--level must be 0, 1 or 2 (got "${opts.level}")`);
}

// A project-scoped token uploading without a project ID is refused by the
// control plane with a 403 that is easy to misread. Say so before the round
// trip rather than after.
const projectId = opts.project ?? process.env.EE_CDN_PROJECT_ID;
if (!projectId && !opts['dry-run']) {
  console.error(
    'ee-deploy: warning — no --project and no EE_CDN_PROJECT_ID. If your token\n' +
      '           is project-scoped the control plane will reject this with a 403.',
  );
}

// Packaging takes time and prints a content hash, which reads like progress.
// A missing token is only discovered at upload, so check it up front.
if (!opts['dry-run'] && !(opts.token ?? process.env.EE_CDN_TOKEN)) {
  fail('No deploy token. Set EE_CDN_TOKEN (portal → Workload → Deploy Tokens) or pass --token.');
}

const logger = opts.quiet
  ? { info() {}, warn: console.warn }
  : { info: (m) => console.log(m), warn: (m) => console.warn(m) };

try {
  const result = await deploySite({
    dir,
    trailingSlash: opts['trailing-slash'],
    cleanUrls: opts['clean-urls'],
    builderVersion: opts['builder-version'] ?? process.env.EE_BUILDER_VERSION ?? 'latest',
    domain,
    name: opts.name,
    level,
    controlPlane: opts['control-plane'] ?? DEFAULT_CONTROL_PLANE,
    token: opts.token ?? process.env.EE_CDN_TOKEN,
    dryRun: opts['dry-run'],
    builderPath: opts.builder ?? null,
    lockfilePath: opts.lockfile ?? '.ee-builder-lock.json',
    ...(opts['cache-dir'] ? { cacheDir: opts['cache-dir'] } : {}),
    metadata: {
      projectId,
      orgId: opts.org,
      buildId: opts.build ?? process.env.EE_CDN_BUILD_ID,
    },
    logger,
  });
  if (opts.quiet) console.log(result.hash);
  process.exit(0);
} catch (err) {
  console.error(`ee-deploy: ${err.message}`);
  process.exit(1);
}
