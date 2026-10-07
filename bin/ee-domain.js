#!/usr/bin/env node
/**
 * ee-domain — claim a custom domain for a project and watch it go live.
 *
 *   ee-domain claim blog.example.com --project proj_abc --wait
 *
 * Prints the two DNS records to add, then (with --wait) checks until the
 * claim is active. Replaces setting certificates up by hand.
 */
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

import { DEFAULT_CONTROL_PLANE } from '../src/builder.js';
import {
  createClaim,
  describeClaim,
  formatRecords,
  getClaim,
  verifyNow,
  waitForActive,
} from '../src/domains.js';

const { version } = createRequire(import.meta.url)('../package.json');

const USAGE = `
ee-domain — custom domains on the Evolving Edge CDN

USAGE
  ee-domain claim  <domain> --project <id> [--org <id>] [--wait]
  ee-domain status <domain>
  ee-domain verify <domain> [--wait]

COMMANDS
  claim    Claim <domain> for a project. Prints the TXT and CNAME records
           to add at your DNS provider.
  status   Show where a claim stands, and the records if it is still pending.
  verify   Check for the TXT record now instead of waiting for the next pass.

OPTIONS
  --project <id>         Project the domain is for. Defaults to $EE_CDN_PROJECT_ID.
  --org <id>             Organisation ID
  --wait                 Keep checking until the claim is active (or fails)
  --interval <seconds>   Between checks with --wait. Default 30
  --timeout <minutes>    Give up waiting after this long. Default 120
  --token <token>        Defaults to $EE_CDN_TOKEN. Admin only for now.
  --control-plane <url>  Default ${DEFAULT_CONTROL_PLANE}
  --json                 Print the control plane's response as JSON
  --version, -v
  --help, -h

EXAMPLES
  ee-domain claim blog.example.com --project proj_abc --wait
  ee-domain status blog.example.com
`;

function fail(message, { usage = false, code = 2 } = {}) {
  console.error(`ee-domain: ${message}`);
  if (usage) console.error('\nRun `ee-domain --help` for usage.');
  process.exit(code);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: 'string' },
      org: { type: 'string' },
      wait: { type: 'boolean', default: false },
      interval: { type: 'string' },
      timeout: { type: 'string' },
      token: { type: 'string' },
      'control-plane': { type: 'string' },
      json: { type: 'boolean', default: false },
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

const [command, domain, ...extra] = positionals;
if (!['claim', 'status', 'verify'].includes(command)) {
  fail(command ? `unknown command "${command}"` : 'a command is required', { usage: true });
}
if (!domain) fail(`${command} needs a domain`, { usage: true });
if (extra.length) fail(`unexpected arguments: ${extra.join(' ')}`, { usage: true });

const token = opts.token ?? process.env.EE_CDN_TOKEN;
if (!token) fail('No token. Set EE_CDN_TOKEN or pass --token.');

const positiveNumber = (value, name, fallback) => {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) fail(`--${name} must be a positive number (got "${value}")`);
  return n;
};
const intervalMs = positiveNumber(opts.interval, 'interval', 30) * 1000;
const timeoutMs = positiveNumber(opts.timeout, 'timeout', 120) * 60 * 1000;

const api = { controlPlane: opts['control-plane'] ?? DEFAULT_CONTROL_PLANE, token, domain };

function show(view) {
  if (opts.json) {
    console.log(JSON.stringify(view, null, 2));
    return;
  }
  console.log(describeClaim(view.claim));
  if (view.records) {
    console.log('\nAdd these records at your DNS provider:\n');
    console.log(formatRecords(view.records));
    console.log('');
  }
}

async function wait() {
  const claim = await waitForActive({
    ...api,
    intervalMs,
    timeoutMs,
    onTick: (line) => {
      if (!opts.json) console.log(line);
    },
  });
  if (opts.json) console.log(JSON.stringify({ claim }, null, 2));
  else console.log(`${claim.domain} is active.`);
}

try {
  if (command === 'claim') {
    const projectId = opts.project ?? process.env.EE_CDN_PROJECT_ID;
    if (!projectId) fail('claim needs --project (or EE_CDN_PROJECT_ID)', { usage: true });
    show(await createClaim({ ...api, projectId, orgId: opts.org }));
    if (opts.wait) await wait();
  } else if (command === 'status') {
    show(await getClaim(api));
  } else {
    const view = await verifyNow(api);
    if (view.lookupFailed && !opts.json) {
      console.log('The DNS lookup failed, so the record was not checked. Try again shortly.');
    }
    show(view);
    if (opts.wait) await wait();
  }
  process.exit(0);
} catch (err) {
  fail(err.message, { code: 1 });
}
