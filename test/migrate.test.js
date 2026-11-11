/**
 * ee-migrate (#938): runs ee-builder -migrate with the right arguments and
 * environment, passes its exit status through, and refuses a builder from
 * before -migrate. A stand-in builder records how it was called.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { builderFlags } from '../src/builder.js';
import { MIGRATE_FLAGS, migrateArgs } from '../src/migrate.js';

const CLI = fileURLToPath(new URL('../bin/ee-migrate.js', import.meta.url));
const ALL_FLAGS = MIGRATE_FLAGS.map((f) => `  ${f}${f === '-strict' ? '' : ' string'}\\n`).join('');

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function fresh() {
  const d = mkdtempSync(join(tmpdir(), 'ee-migrate-'));
  dirs.push(d);
  return d;
}

/**
 * A stand-in ee-builder. -h lists `usage`; any other call appends its
 * arguments (one per line, then a blank line) to args.txt, its environment
 * to env.txt, prints a summary line and exits with `status`.
 */
function fakeBuilder(dir, { usage = ALL_FLAGS, status = 0 } = {}) {
  const bin = join(dir, 'fake-ee-builder');
  const argsFile = join(dir, 'args.txt');
  const envFile = join(dir, 'env.txt');
  writeFileSync(
    bin,
    `#!/bin/sh\n` +
      `if [ "$1" = "-h" ]; then printf '${usage}' >&2; exit 0; fi\n` +
      `for a in "$@"; do printf '%s\\n' "$a" >> "${argsFile}"; done\n` +
      `printf '\\n' >> "${argsFile}"\n` +
      `env > "${envFile}"\n` +
      `echo "Carried over: 1 of 1 settings"\n` +
      `exit ${status}\n`,
    { mode: 0o755 },
  );
  const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  return { bin, calls: () => read(argsFile).split('\n\n').filter(Boolean).map((c) => c.split('\n')), env: () => read(envFile) };
}

function site(dir) {
  const s = join(dir, 'my site');
  mkdirSync(s, { recursive: true });
  writeFileSync(join(s, 'netlify.toml'), '[[redirects]]\nfrom = "/a"\nto = "/b"\n');
  return s;
}

function run(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('ee-migrate', () => {
  it('runs ee-builder -migrate on the folder, with every option as an absolute path', () => {
    const d = fresh();
    const s = site(d);
    const b = fakeBuilder(d);
    const r = run(['my site', '--strict', '--report', 'out/r.json', '--redirects', 'my site/_redirects', '--headers', 'h/_headers', '--builder', b.bin], { cwd: d });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Carried over: 1 of 1 settings/);
    assert.deepEqual(b.calls(), [[
      '-migrate', s,
      '-migrate-report', join(d, 'out/r.json'),
      '-migrate-redirects', join(s, '_redirects'),
      '-migrate-headers', join(d, 'h/_headers'),
      '-strict',
    ]]);
  });

  it('defaults to the current folder and passes nothing it was not given', () => {
    const d = fresh();
    const s = site(d);
    const b = fakeBuilder(d);
    const r = run(['--builder', b.bin], { cwd: s });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(b.calls(), [['-migrate', s]]);
  });

  it("passes ee-builder's exit status through (1: stopped, or --strict and something was dropped)", () => {
    const d = fresh();
    const s = site(d);
    const b = fakeBuilder(d, { status: 1 });
    const r = run(['my site', '--strict', '--builder', b.bin], { cwd: d });
    assert.equal(r.status, 1);
    // The 1 is the builder's, not one of ee-migrate's own errors.
    assert.deepEqual(b.calls(), [['-migrate', s, '-strict']]);
    assert.doesNotMatch(r.stderr, /ee-migrate:/);
  });

  it('runs ee-builder without the deploy token (#832)', () => {
    const d = fresh();
    site(d);
    const b = fakeBuilder(d);
    const r = run(['my site', '--builder', b.bin], { cwd: d, env: { EE_CDN_TOKEN: 'tok-secret', DATABASE_URL: 'postgres://x' } });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(b.env(), /tok-secret|EE_CDN_TOKEN|DATABASE_URL/);
  });

  it('refuses an ee-builder from before -migrate, naming what it lacks', () => {
    const d = fresh();
    site(d);
    const b = fakeBuilder(d, { usage: '  -images string\\n  -migrate-report string\\n' });
    const r = run(['my site', '--builder', b.bin], { cwd: d });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /too old to migrate: it has no -migrate, -migrate-redirects, -migrate-headers, -strict/);
    assert.deepEqual(b.calls(), []);
  });

  it('names the lockfile only when it pins latest, and never leaves a refused builder pinned (#965, #966)', async () => {
    const d = fresh();
    site(d);
    const b = fakeBuilder(d, { usage: '  -images string\\n' });
    const cache = join(d, 'cache');
    mkdirSync(cache);
    // A cached latest with no published digest to compare (offline): the
    // stand-in is put where ensureBuilder looks, and the control plane is
    // unreachable.
    const { cachedBuilderName } = await import('../src/builder.js');
    const os = { linux: 'linux', darwin: 'darwin' }[process.platform];
    const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
    const key = `${os}-${arch}`;
    writeFileSync(join(cache, cachedBuilderName('latest', key, os)), readFileSync(b.bin), { mode: 0o755 });
    const lock = join(d, 'lock.json');
    const opts = ['my site', '-q', '--cache-dir', cache, '--lockfile', lock, '--control-plane', 'http://127.0.0.1:9'];

    // No lockfile before: the refused builder isn't pinned, run after run.
    for (let i = 0; i < 2; i++) {
      const r = run(opts, { cwd: d });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /The latest ee-builder it found, downloaded or cached, predates it/);
      assert.doesNotMatch(r.stderr, /pins an older/);
      assert.ok(!existsSync(lock), 'the refused builder was left pinned');
    }

    // A lockfile with other entries: put back byte for byte.
    const other = '{\n  "2026-11-03:linux-amd64": "' + 'b'.repeat(64) + '"\n}\n';
    writeFileSync(lock, other);
    let r = run(opts, { cwd: d });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is back as it was before this run/);
    assert.equal(readFileSync(lock, 'utf8'), other);

    // A lockfile that already pinned latest: named, and left as it is.
    const { createHash } = await import('node:crypto');
    const pinned = JSON.stringify({ [`latest:${key}`]: createHash('sha256').update(readFileSync(b.bin)).digest('hex') });
    writeFileSync(lock, pinned);
    r = run(opts, { cwd: d });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /lock\.json pins an older ee-builder latest/);
    assert.doesNotMatch(r.stderr, /back as it was/);
    assert.equal(readFileSync(lock, 'utf8'), pinned);
    assert.deepEqual(b.calls(), []);
  });

  it('stops on a folder that is not there, and on two folders', () => {
    const d = fresh();
    const b = fakeBuilder(d);
    let r = run(['nope', '--builder', b.bin], { cwd: d });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Not a directory/);
    r = run(['a', 'b', '--builder', b.bin], { cwd: d });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /expected one folder/);
    r = run(['--nope'], { cwd: d });
    assert.equal(r.status, 2);
    assert.deepEqual(b.calls(), []);
  });

  it('prints its usage', () => {
    const r = run(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ee-migrate \[folder\] \[options\]/);
    assert.match(r.stdout, /--strict/);
  });
});

describe('migrateArgs and builderFlags', () => {
  it('builds the argument list', () => {
    assert.deepEqual(migrateArgs({ dir: '/s' }), ['-migrate', '/s']);
    assert.deepEqual(migrateArgs({ dir: '/s', strict: true }), ['-migrate', '/s', '-strict']);
  });

  it('matches a flag only by its whole name', () => {
    const d = fresh();
    const b = fakeBuilder(d, { usage: '  -migrate-report string\\n  -strict\\n' });
    assert.deepEqual(builderFlags(b.bin, ['-migrate', '-migrate-report', '-strict']), ['-migrate-report', '-strict']);
  });
});
