/**
 * Deploying content the control plane already holds (#560).
 *
 * A rebuilt Level 1 or Level 2 package has the same content hash as the one
 * stored and different bytes (a new random secret), so uploading it is refused
 * with 409. The deploy paths ask whether the hash is stored first and, when it
 * is stored at the level asked for and this project owns it, deploy what is
 * stored without uploading.
 *
 * test/fixtures/level1-stored.json holds two real Level 1 packages of one site
 * built by ee-builder: the status the control plane returns for the first,
 * the first package's key, and the second's.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, afterEach, describe, it } from 'node:test';

import { decideStored, level1KeyOpens } from '../src/upload.js';
import { deploySite } from '../src/deploy.js';

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/level1-stored.json', import.meta.url), 'utf8'),
);
const L1 = FIXTURE.status;
const HASH = L1.hash;

const scratch = mkdtempSync(join(tmpdir(), 'ee-stored-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = (name) => {
  const d = join(scratch, `${name}-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The hex secret and salt inside a base64url key. */
function partsOf(key) {
  const raw = Buffer.from(key, 'base64url');
  return { secret: raw.subarray(0, 32).toString('hex'), salt: raw.subarray(32).toString('hex') };
}

/**
 * A stand-in for ee-builder that prints, as ee-builder does, the summary in
 * <dir>/summary.txt, which a test can change between builds.
 */
function fakeBuilder(dir, { hash = HASH, secret, salt }) {
  const bin = join(dir, 'fake-ee-builder');
  const summary = join(dir, 'summary.txt');
  const write = (s) =>
    writeFileSync(
      summary,
      `Content hash: ${hash}\nFiles: 1\n` + (s.secret ? `  Secret: ${s.secret}\n  Salt: ${s.salt}\n` : ''),
    );
  write({ secret, salt });
  writeFileSync(
    bin,
    `#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do [ "$1" = "-out" ] && out="$2"; shift; done\n` +
      `[ -n "$out" ] && printf 'rebuilt-bytes' > "$out"\ncat "${summary}"\n`,
    { mode: 0o755 },
  );
  return { bin, set: write };
}

/**
 * A control plane: the status of one stored workload (or none), and every
 * request recorded.
 */
function controlPlane(status) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    // The package limit (#823): not recorded; 404 as from a control plane
    // without the route, so the 1 GiB default applies.
    if (u.endsWith('/api/limits')) return { ok: false, status: 404, statusText: 'Not Found', text: async () => '' };
    calls.push({ url: u, method: opts.method ?? 'GET', headers: opts.headers ?? {} });
    const reply = (code, body) => ({
      ok: code >= 200 && code < 300,
      status: code,
      statusText: code === 200 ? 'OK' : 'Error',
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    if (u.includes('/status')) return reply(200, status ?? { hash: HASH, stored: false });
    if (u.includes('/deploy')) return reply(200, { uploaded: false, alias: 'big-lilac' });
    if (u.includes('/store-raw')) {
      // As the control plane does: a stored hash keeps its first bytes.
      return status?.stored ? reply(409, { error: 'workload already exists with different bytes' }) : reply(200, {});
    }
    return reply(404, 'not found');
  };
  return {
    calls,
    saw: (s) => calls.some((c) => c.url.includes(s)),
  };
}

function recordingLogger() {
  const lines = [];
  return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(m) };
}

function siteDir(d) {
  const s = join(d, 'site');
  mkdirSync(s, { recursive: true });
  writeFileSync(join(s, 'index.html'), '<h1>hi</h1>');
  return s;
}

const first = partsOf(FIXTURE.firstKey);
const rebuilt = partsOf(FIXTURE.rebuildKey);

describe('a Level 1 key against the stored workload', () => {
  it('opens it with the first deploy\'s key, and not with a rebuild\'s', () => {
    assert.equal(level1KeyOpens(FIXTURE.firstKey, L1), true);
    assert.equal(level1KeyOpens(`${FIXTURE.firstKey}=`, L1), true, 'padding is tolerated');
    // A long run of '=' not at the end is refused at once (no backtracking).
    const t0 = performance.now();
    assert.equal(level1KeyOpens('='.repeat(100000) + 'x', L1), false);
    assert.ok(performance.now() - t0 < 200, 'a long run of = is handled in linear time');
    assert.equal(level1KeyOpens(FIXTURE.rebuildKey, L1), false);
    assert.equal(level1KeyOpens('not-a-key', L1), false);
    assert.equal(level1KeyOpens(FIXTURE.firstKey, { ...L1, index: '' }), false);
  });
});

describe('deciding between uploading and deploying what is stored', () => {
  const l0 = { stored: true, owned: true, level: 0 };
  const l2 = { stored: true, owned: true, level: 2, secretHeld: true };

  it('uploads what is not stored, or not this project\'s', () => {
    assert.deepEqual(decideStored(null, 1), { useStored: false });
    assert.deepEqual(decideStored({ stored: false }, 2), { useStored: false });
    assert.deepEqual(decideStored({ ...l0, owned: false }, 0), { useStored: false });
  });

  it('deploys the stored workload at Level 0, and at Level 2 only with a secret held', () => {
    assert.deepEqual(decideStored(l0, 0), { useStored: true });
    assert.deepEqual(decideStored(l2, 2), { useStored: true });
    assert.deepEqual(decideStored({ ...l2, secretHeld: false }, 2), { useStored: false });
  });

  it('at Level 1, only with a key that opens it', () => {
    assert.deepEqual(decideStored(L1, 1, [FIXTURE.rebuildKey, FIXTURE.firstKey]), { useStored: true, key: FIXTURE.firstKey });
    assert.throws(() => decideStored(L1, 1, []), /already stored at Level 1.*--key.*no key was given or cached/s);
    assert.throws(() => decideStored(L1, 1, [null]), /no key was given or cached/);
    assert.throws(() => decideStored(L1, 1, [FIXTURE.rebuildKey]), /the key given does not open the stored content/);
  });

  it('refuses a level other than the stored one', () => {
    assert.throws(() => decideStored(l0, 2), /already stored at Level 0, and this deploy is Level 2/);
    assert.throws(() => decideStored(l0, 1, [FIXTURE.firstKey]), /already stored at Level 0, and this deploy is Level 1/);
    assert.throws(() => decideStored(l2, 0), /already stored at Level 2, and this deploy is Level 0/);
  });
});

describe('deploySite with content already stored', () => {
  const opts = (d, extra) => ({
    dir: siteDir(d),
    domain: 'blog.example.com',
    controlPlane: 'https://cp.example.test',
    token: 't',
    cacheDir: join(d, 'cache'),
    metadata: { projectId: 'proj_a' },
    ...extra,
  });

  it('Level 1: deploys what is stored with the first deploy\'s key, uploads nothing and hands back no new key', async () => {
    const d = fresh('l1');
    const fb = fakeBuilder(d, rebuilt);
    const cp = controlPlane(L1);
    const log = recordingLogger();
    const r = await deploySite(opts(d, { level: 1, key: FIXTURE.firstKey, builderPath: fb.bin, logger: log }));
    assert.equal(r.uploaded, false);
    assert.equal(r.alreadyStored, true);
    assert.equal(r.key, FIXTURE.firstKey, 'the stored content\'s key');
    assert.equal(r.secret, undefined);
    assert.equal(r.salt, undefined);
    assert.ok(!cp.saw('/store-raw'), 'nothing uploaded');
    assert.ok(!cp.saw('/digest'), 'no digest sent');
    const deploy = cp.calls.find((c) => c.url.includes(`/api/workloads/${HASH}/deploy?`));
    assert.ok(deploy, 'the stored workload was deployed');
    assert.equal(deploy.method, 'POST');
    assert.match(deploy.url, /encryptionLevel=level1/);
    assert.match(deploy.url, /domain=blog\.example\.com/);
    assert.match(deploy.url, /projectId=proj_a/);
    assert.match(cp.calls[0].url, /\/status\?projectId=proj_a$/);
    const out = log.lines.join('\n');
    assert.ok(!out.includes(FIXTURE.rebuildKey) && !out.includes(rebuilt.secret), 'the rebuild\'s key is never printed');
    assert.match(out, /nothing uploaded/);
  });

  it('Level 1 with no key (an empty cache): fails clearly and sends nothing', async () => {
    const d = fresh('l1-nokey');
    const fb = fakeBuilder(d, rebuilt);
    const cp = controlPlane(L1);
    await assert.rejects(
      deploySite(opts(d, { level: 1, builderPath: fb.bin, logger: recordingLogger() })),
      /already stored at Level 1.*--key/s,
    );
    assert.deepEqual(cp.calls.map((c) => c.method + ' ' + c.url.split('?')[0].split('/').pop()), ['GET status']);
  });

  it('Level 1 with the rebuild\'s own key: fails and sends nothing', async () => {
    const d = fresh('l1-wrongkey');
    const fb = fakeBuilder(d, rebuilt);
    const cp = controlPlane(L1);
    await assert.rejects(
      deploySite(opts(d, { level: 1, key: FIXTURE.rebuildKey, builderPath: fb.bin, logger: recordingLogger() })),
      /does not open the stored content/,
    );
    assert.ok(!cp.saw('/store-raw') && !cp.saw('/deploy'));
  });

  it('Level 2: deploys what is stored when its secret is held, sending no secret', async () => {
    const d = fresh('l2');
    const fb = fakeBuilder(d, rebuilt);
    const cp = controlPlane({ hash: HASH, stored: true, owned: true, level: 2, secretHeld: true });
    const r = await deploySite(opts(d, { level: 2, builderPath: fb.bin, logger: recordingLogger() }));
    assert.equal(r.uploaded, false);
    assert.ok(!cp.saw('/store-raw'));
    for (const c of cp.calls) {
      assert.equal(c.headers['X-EE-Workload-Secret'], undefined, 'no secret travels on a deploy without upload');
      assert.ok(!c.url.includes(rebuilt.secret));
    }
    assert.ok(cp.saw('/deploy?') && cp.saw('encryptionLevel=level2'));
  });

  it('Level 2 with no secret held: uploads, which registers one for identical bytes', async () => {
    const d = fresh('l2-nosecret');
    const fb = fakeBuilder(d, rebuilt);
    const cp = controlPlane({ hash: HASH, stored: true, owned: true, level: 2, secretHeld: false });
    await assert.rejects(deploySite(opts(d, { level: 2, builderPath: fb.bin, logger: recordingLogger() })), /409/);
    const upload = cp.calls.find((c) => c.url.includes('/store-raw'));
    assert.equal(upload.headers['X-EE-Workload-Secret'], rebuilt.secret);
    assert.ok(!cp.saw('/deploy?'));
  });

  it('Level 0: a redeploy or rollback deploys what is stored', async () => {
    const d = fresh('l0');
    const fb = fakeBuilder(d, {});
    const cp = controlPlane({ hash: HASH, stored: true, owned: true, level: 0 });
    const r = await deploySite(opts(d, { level: 0, builderPath: fb.bin, logger: recordingLogger() }));
    assert.equal(r.uploaded, false);
    assert.ok(!cp.saw('/store-raw') && cp.saw('encryptionLevel=level0'));
  });

  for (const [stored, asked] of [[0, 2], [0, 1], [2, 0]]) {
    it(`refuses Level ${stored} -> Level ${asked} and sends nothing`, async () => {
      const d = fresh(`mismatch-${stored}-${asked}`);
      const fb = fakeBuilder(d, asked ? rebuilt : {});
      const cp = controlPlane({ hash: HASH, stored: true, owned: true, level: stored, secretHeld: true });
      await assert.rejects(
        deploySite(opts(d, { level: asked, key: asked === 1 ? FIXTURE.firstKey : null, builderPath: fb.bin, logger: recordingLogger() })),
        new RegExp(`already stored at Level ${stored}`),
      );
      assert.ok(!cp.saw('/store-raw') && !cp.saw('/deploy'));
    });
  }

  it('another project\'s content is left to the upload, which the control plane refuses', async () => {
    const d = fresh('foreign');
    const fb = fakeBuilder(d, {});
    const cp = controlPlane({ hash: HASH, stored: true, owned: false, level: 0 });
    await assert.rejects(deploySite(opts(d, { level: 0, builderPath: fb.bin, logger: recordingLogger() })), /409/);
    assert.ok(cp.saw('/store-raw') && !cp.saw('/deploy'));
  });

  // A control plane from before #560 has no status route: the request falls
  // through to a metadata read that needs read:workloads, which a deploy
  // token lacks, so it answers 403 (or 404 with a broader token).
  for (const code of [403, 404]) {
    it(`an older control plane answering ${code} gets the upload as before`, async () => {
      const d = fresh(`old-${code}`);
      const fb = fakeBuilder(d, rebuilt);
      const calls = [];
      globalThis.fetch = async (url) => {
        calls.push(String(url));
        const isStatus = String(url).includes('/status');
        return {
          ok: !isStatus,
          status: isStatus ? code : 200,
          statusText: isStatus ? 'Error' : 'OK',
          text: async () => (isStatus ? '{"error":"Insufficient permissions"}' : '{}'),
        };
      };
      const r = await deploySite(opts(d, { level: 2, builderPath: fb.bin, logger: recordingLogger() }));
      assert.equal(r.uploaded, true);
      assert.ok(calls.some((u) => u.includes('/store-raw')));
    });
  }

  it('content not stored is uploaded as before', async () => {
    const d = fresh('new');
    const fb = fakeBuilder(d, rebuilt);
    const cp = controlPlane(null);
    const r = await deploySite(opts(d, { level: 2, builderPath: fb.bin, logger: recordingLogger() }));
    assert.equal(r.uploaded, true);
    assert.ok(cp.saw('/store-raw') && !cp.saw('/deploy'));
  });
});

describe('Astro Level 1 sub-workload already stored', () => {
  async function runAstro(root, name) {
    const eeCdn = (await import('../src/astro.js')).default;
    const integration = eeCdn({
      workloads: [{ name, src: 'assets', level: 1 }],
      builderPath: 'fake-ee-builder',
      controlPlane: 'https://cp.example.test',
      token: 't',
      deploy: { domain: 'example.com', projectId: 'proj_a' },
      outputFile: 'workloads.json',
      cacheFile: '.cache.json',
    });
    const log = recordingLogger();
    integration.hooks['astro:config:setup']({ config: { root: pathToFileURL(`${root}/`), build: {} }, logger: log });
    await integration.hooks['astro:build:start']({ logger: log });
    return log;
  }

  it('uses the cached key that opens what is stored, and never the rebuild\'s', async () => {
    const root = fresh('astro');
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'assets', 'a.txt'), 'content');
    const fb = fakeBuilder(root, first);

    // First deploy: not stored yet, so it uploads and caches its key.
    controlPlane(null);
    await runAstro(root, 'w');
    assert.equal(JSON.parse(readFileSync(join(root, 'workloads.json'), 'utf8')).w.key, FIXTURE.firstKey);

    // The same content again under another name (a cache miss), rebuilt with
    // a new secret: the control plane holds the first package.
    fb.set(rebuilt);
    const cp = controlPlane(L1);
    const log = await runAstro(root, 'w2');
    assert.ok(!cp.saw('/store-raw'), 'nothing uploaded');
    assert.ok(cp.saw('/deploy?'), 'the stored workload deployed');
    const built = JSON.parse(readFileSync(join(root, 'workloads.json'), 'utf8'));
    assert.equal(built.w2.key, FIXTURE.firstKey, 'the page gets the key that opens what is stored');
    assert.ok(!log.lines.join('\n').includes(FIXTURE.rebuildKey), 'the rebuild\'s key is never printed');
  });

  it('keeps and shows a first upload\'s key before sending it, so a lost response loses no key', async () => {
    const root = fresh('astro-lost');
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'assets', 'a.txt'), 'content');
    const fb = fakeBuilder(root, first);

    // Not stored yet; the upload reaches the control plane (which stores it)
    // but its response never comes back.
    const sent = [];
    globalThis.fetch = async (url) => {
      const u = String(url);
      sent.push(u);
      if (u.includes('/status')) {
        return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ hash: HASH, stored: false }) };
      }
      throw new Error('socket hang up');
    };
    const eeCdn = (await import('../src/astro.js')).default;
    const integration = eeCdn({
      workloads: [{ name: 'w', src: 'assets', level: 1 }],
      builderPath: 'fake-ee-builder',
      controlPlane: 'https://cp.example.test',
      token: 't',
      deploy: { domain: 'example.com', projectId: 'proj_a' },
      outputFile: 'workloads.json',
      cacheFile: '.cache.json',
    });
    const log = recordingLogger();
    integration.hooks['astro:config:setup']({ config: { root: pathToFileURL(`${root}/`), build: {} }, logger: log });
    await assert.rejects(integration.hooks['astro:build:start']({ logger: log }), /socket hang up/);
    assert.ok(sent.some((u) => u.includes('/store-raw')), 'the upload was sent');
    assert.match(log.lines.join('\n'), new RegExp(FIXTURE.firstKey), 'the key was shown before the upload');
    const cached = Object.values(JSON.parse(readFileSync(join(root, '.cache.json'), 'utf8')));
    assert.equal(cached.length, 1);
    assert.equal(cached[0].key, FIXTURE.firstKey);
    assert.equal(cached[0].uploaded, false, 'not marked uploaded, so the next build asks again');

    // The next build finds the content stored and opens it with that key.
    fb.set(rebuilt);
    const cp = controlPlane(L1);
    await runAstro(root, 'w');
    assert.ok(cp.saw('/deploy?') && !cp.saw('/store-raw'));
    assert.equal(JSON.parse(readFileSync(join(root, 'workloads.json'), 'utf8')).w.key, FIXTURE.firstKey);
  });

  it('keeps a lost upload\'s key when a retry\'s upload is refused', async () => {
    const root = fresh('astro-refused');
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'assets', 'a.txt'), 'content');
    const fb = fakeBuilder(root, first);

    // The first upload stores the package but its response is lost: the
    // first key is cached, not marked uploaded.
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/status')) {
        return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ hash: HASH, stored: false }) };
      }
      throw new Error('socket hang up');
    };
    await assert.rejects(runAstro(root, 'w'), /socket hang up/);

    // A retry with another project's token: the content is not this
    // caller's, so it uploads its rebuild, and the control plane refuses it.
    fb.set(rebuilt);
    globalThis.fetch = async (url) => {
      const u = String(url);
      const reply = (code, body) => ({ ok: code < 300, status: code, statusText: 'x', text: async () => JSON.stringify(body) });
      if (u.includes('/status')) return reply(200, { ...L1, owned: false });
      return reply(403, { error: 'not the workload owner' });
    };
    await assert.rejects(runAstro(root, 'w'));

    // With the right token, the first key still opens what is stored.
    const cp = controlPlane(L1);
    await runAstro(root, 'w');
    assert.ok(cp.saw('/deploy?') && !cp.saw('/store-raw'));
    assert.equal(JSON.parse(readFileSync(join(root, 'workloads.json'), 'utf8')).w.key, FIXTURE.firstKey);
  });

  it('fails with an empty key cache', async () => {
    const root = fresh('astro-empty');
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'assets', 'a.txt'), 'content');
    fakeBuilder(root, rebuilt);
    const cp = controlPlane(L1);
    await assert.rejects(runAstro(root, 'w'), /already stored at Level 1/);
    assert.ok(!cp.saw('/store-raw') && !cp.saw('/deploy'));
  });
});
