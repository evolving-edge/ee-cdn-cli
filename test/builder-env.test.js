/**
 * ee-builder runs without the deploy token or other credentials (#832).
 *
 * ee-builder is downloaded at run time and never needs the token: the CLI
 * uploads, and builderArgs never passes -upload. These tests start a stand-in
 * builder that records its environment, through the real CLI and the two
 * functions that start it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { builderEnv, builderImageFlags, runBuilder } from '../src/builder.js';

const CLI = fileURLToPath(new URL('../bin/ee-deploy.js', import.meta.url));
const HASH = 'a'.repeat(64);

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function fresh() {
  const d = mkdtempSync(join(tmpdir(), 'ee-builder-env-'));
  dirs.push(d);
  return d;
}

/**
 * A stand-in for ee-builder that writes its environment to envFile on every
 * call, answers -h with the image flags, and prints the summary runBuilder
 * parses.
 */
function envBuilder(dir) {
  const bin = join(dir, 'fake-ee-builder');
  const envFile = join(dir, 'env.txt');
  writeFileSync(
    bin,
    `#!/bin/sh\n` +
      `env >> "${envFile}"\n` +
      `if [ "$1" = "-h" ]; then printf '  -image-hosts string\\n  -image-report string\\n  -images string\\n  -image-max-width int\\n' >&2; exit 0; fi\n` +
      `if [ "$1" = "-version" ]; then echo "ee-builder test images:1 webp(x) avif(y)"; exit 0; fi\n` +
      `out=""\n` +
      `while [ $# -gt 0 ]; do [ "$1" = "-out" ] && out="$2"; shift; done\n` +
      `[ -n "$out" ] && printf 'workload' > "$out"\n` +
      `echo "Content hash: ${HASH}"\n` +
      `echo "Files: 1"\n`,
    { mode: 0o755 },
  );
  return { bin, env: () => (existsSync(envFile) ? readFileSync(envFile, 'utf8') : '') };
}

function site(dir) {
  const s = join(dir, 'site');
  mkdirSync(s, { recursive: true });
  writeFileSync(join(s, 'index.html'), '<p>hi</p>');
  return s;
}

const SECRETS = {
  EE_CDN_TOKEN: 'ee-token-832',
  GITHUB_TOKEN: 'gh-token-832',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-832',
  NPM_TOKEN: 'npm-832',
  AWS_SECRET_ACCESS_KEY: 'aws-832',
  DB_PASSWORD: 'pw-832',
  OPENAI_API_KEY: 'key-832',
  // Credentials whose names don't say so: kept out by the allowlist.
  SSH_AUTH_SOCK: '/tmp/ssh-agent-832',
  DATABASE_URL: 'postgres://u:pass-832@db/x',
  GH_PAT: 'pat-832',
  GOOGLE_APPLICATION_CREDENTIALS: '/keys/gcp-832.json',
};

describe('builderEnv (#832)', () => {
  it('leaves out the deploy token and every credential, whatever it is named', () => {
    const env = builderEnv({ ...SECRETS, PATH: '/bin', HOME: '/home/u' });
    for (const name of Object.keys(SECRETS)) assert.equal(name in env, false, `${name} should be left out`);
  });

  it('keeps what a Go program needs on each platform, and nothing else', () => {
    const kept = {
      PATH: '/usr/bin:/bin',
      HOME: '/home/u',
      TMPDIR: '/tmp',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C.UTF-8',
      XDG_CACHE_HOME: '/cache',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\u',
      GOMAXPROCS: '2',
    };
    const dropped = { EE_CDN_PROJECT_ID: 'proj_abc', NODE_OPTIONS: '--x', CI: 'true' };
    assert.deepEqual(builderEnv({ ...kept, ...dropped, ...SECRETS }), kept);
  });

  it('matches names in any case, as Windows does', () => {
    assert.deepEqual(builderEnv({ ee_cdn_token: 'x', Path: 'C:\\bin', systemroot: 'C:\\Windows' }), { Path: 'C:\\bin', systemroot: 'C:\\Windows' });
  });
});

describe('ee-builder is started without the token (#832)', () => {
  const saved = {};
  function withSecrets(fn) {
    for (const [k, v] of Object.entries(SECRETS)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      for (const k of Object.keys(SECRETS)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }

  function assertClean(recorded) {
    assert.ok(recorded.length > 0, 'the builder ran');
    for (const [name, value] of Object.entries(SECRETS)) {
      assert.equal(recorded.includes(value), false, `${name} reached the builder`);
    }
    assert.match(recorded, /^PATH=/m, 'PATH still reaches the builder');
  }

  it('runBuilder, for packaging', () => {
    const d = fresh();
    const fb = envBuilder(d);
    withSecrets(() => runBuilder(fb.bin, { src: site(d), out: join(d, 'out.ee'), level: 0 }));
    assertClean(fb.env());
  });

  it('builderImageFlags, for -h', () => {
    const d = fresh();
    const fb = envBuilder(d);
    withSecrets(() => builderImageFlags(fb.bin));
    assertClean(fb.env());
  });

  it('the ee-deploy CLI, with image conversion on, through every call to the builder', () => {
    const d = fresh();
    const fb = envBuilder(d);
    const r = spawnSync(
      process.execPath,
      [CLI, site(d), '--domain', 'example.com', '--dry-run', '--images', 'webp', '--builder', fb.bin, '--cache-dir', join(d, 'c')],
      { cwd: d, encoding: 'utf8', env: { ...process.env, ...SECRETS } },
    );
    assert.equal(r.status, 0, r.stderr);
    const recorded = fb.env();
    assertClean(recorded);
    // -h for the image flags, then the packaging run.
    assert.ok(recorded.split(/^PATH=/m).length - 1 >= 2, 'the builder ran at least twice');
  });
});
