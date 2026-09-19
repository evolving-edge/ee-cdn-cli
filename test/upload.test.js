/**
 * Tests for the control-plane client.
 *
 * This is the file that talks to production, and it was the blast radius for
 * every failure we hit taking the first site live: a rejected token, a
 * project-scope mismatch, and a Redis outage that surfaced as a 500. The point
 * of these tests is that each of those still produces a message that tells the
 * operator what to do, and that we never send a request the control plane will
 * reject on shape alone.
 *
 * fetch is stubbed rather than mocked through a seam — storeWorkload calls the
 * global directly, so the global is what we replace.
 */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  truncateSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, afterEach, describe, it } from 'node:test';

import { storeWorkload } from '../src/upload.js';
import { defaultCacheDir } from '../src/deploy.js';

const scratch = mkdtempSync(join(tmpdir(), 'ee-upload-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Records the request and replies with whatever the test asks for. */
function stubFetch({ status = 200, statusText = 'OK', body = '{}' } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      text: async () => body,
    };
  };
  return calls;
}

const quietLogger = { info() {}, warn() {} };

function workload(name, bytes = 'ee-workload-bytes') {
  const p = join(scratch, name);
  writeFileSync(p, bytes);
  return p;
}

const HASH = 'a'.repeat(64);

function call(overrides = {}) {
  return storeWorkload({
    filePath: workload('w.ee'),
    hash: HASH,
    controlPlane: 'https://cp.example.test',
    token: 'tok_123',
    logger: quietLogger,
    ...overrides,
  });
}

describe('storeWorkload request shape', () => {
  it('PUTs the bytes with a bearer token', async () => {
    const calls = stubFetch();
    await call();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.method, 'PUT');
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok_123');
    assert.equal(
      calls[0].opts.headers['Content-Type'],
      'application/octet-stream',
    );
    assert.equal(calls[0].opts.body.toString(), 'ee-workload-bytes');
  });

  it('always sends the hash', async () => {
    const calls = stubFetch();
    await call();
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, '/api/workloads/store-raw');
    assert.equal(url.searchParams.get('hash'), HASH);
  });

  it('passes through the params the endpoint understands', async () => {
    const calls = stubFetch();
    await call({
      params: {
        domain: 'blog.example.test',
        projectId: 'proj_abc',
        encryptionLevel: 'level0',
        fileCount: 12,
      },
    });
    const q = new URL(calls[0].url).searchParams;
    assert.equal(q.get('domain'), 'blog.example.test');
    assert.equal(q.get('projectId'), 'proj_abc');
    assert.equal(q.get('encryptionLevel'), 'level0');
    // Numbers are stringified, not dropped.
    assert.equal(q.get('fileCount'), '12');
  });

  it('omits empty params rather than sending blanks', async () => {
    const calls = stubFetch();
    await call({
      params: { domain: '', projectId: null, buildId: undefined, name: 'site' },
    });
    const q = new URL(calls[0].url).searchParams;
    assert.equal(q.has('domain'), false);
    assert.equal(q.has('projectId'), false);
    assert.equal(q.has('buildId'), false);
    assert.equal(q.get('name'), 'site');
  });

  it('drops params the endpoint does not understand', async () => {
    const calls = stubFetch();
    await call({ params: { nonsense: 'x', domain: 'ok.test' } });
    const q = new URL(calls[0].url).searchParams;
    assert.equal(q.has('nonsense'), false);
    assert.equal(q.get('domain'), 'ok.test');
  });

  it('does not double the slash on a trailing-slash control plane', async () => {
    const calls = stubFetch();
    await call({ controlPlane: 'https://cp.example.test/' });
    assert.ok(
      calls[0].url.startsWith('https://cp.example.test/api/workloads/store-raw?'),
      calls[0].url,
    );
  });
});

describe('storeWorkload size cap', () => {
  it('refuses a body over 100 MB before making a request', async () => {
    const big = join(scratch, 'big.ee');
    writeFileSync(big, '');
    truncateSync(big, 101 * 1024 * 1024); // sparse — costs no disk
    const calls = stubFetch();
    await assert.rejects(
      () => call({ filePath: big }),
      /Workload is 101\.0 MiB; .* over 100 MiB/,
    );
    // The point of the cap is to fail locally, not to be told by the server.
    assert.equal(calls.length, 0);
  });
});

describe('storeWorkload failure messages', () => {
  const cases = [
    [401, /current deploy token/],
    [403, /scoped to a different project/],
    [500, /redis_connected:false/],
  ];

  for (const [status, expected] of cases) {
    it(`explains a ${status}`, async () => {
      stubFetch({ status, statusText: 'Err', body: 'server said no' });
      await assert.rejects(() => call(), (err) => {
        assert.match(err.message, new RegExp(`Upload failed: ${status}`));
        assert.match(err.message, /server said no/); // server text is preserved
        assert.match(err.message, expected);
        return true;
      });
    });
  }

  it('still reports an unrecognised status without inventing advice', async () => {
    stubFetch({ status: 418, statusText: 'Teapot', body: 'nope' });
    await assert.rejects(() => call(), (err) => {
      assert.match(err.message, /Upload failed: 418 Teapot/);
      assert.match(err.message, /nope/);
      return true;
    });
  });
});

describe('storeWorkload success handling', () => {
  it('returns the parsed body', async () => {
    stubFetch({ body: JSON.stringify({ alias: 'maple-wand', hash: HASH }) });
    const body = await call();
    assert.equal(body.alias, 'maple-wand');
  });

  it('tolerates a non-JSON 200 — the upload still stood', async () => {
    stubFetch({ body: 'stored' });
    const body = await call();
    assert.deepEqual(body, {});
  });

  it('names the alias in the log when the server returns one', async () => {
    stubFetch({ body: JSON.stringify({ alias: 'good-tank' }) });
    const lines = [];
    await call({ logger: { info: (m) => lines.push(m), warn() {} } });
    assert.match(lines.join('\n'), /alias good-tank/);
  });
});

describe('defaultCacheDir', () => {
  it('is absolute and namespaced, so the CLI never writes into the site dir', () => {
    const d = defaultCacheDir();
    assert.ok(d.startsWith('/') || /^[A-Za-z]:/.test(d), d);
    assert.match(d, /evolving-edge$/);
  });

  it('honours XDG_CACHE_HOME', () => {
    const prev = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = '/tmp/xdg-probe';
    try {
      assert.equal(defaultCacheDir(), '/tmp/xdg-probe/evolving-edge');
    } finally {
      if (prev === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prev;
    }
  });
});

describe('Level 2 workload secret', () => {
  // The bug this guards (#262): the control plane registers a gateway secret
  // only when this header is present. Without it the upload still returns 200,
  // the deploy reports success, and every edge request for the workload fails
  // with "decryption key unavailable" -- a green build and a broken site.
  it('sends the secret as a header when one is given', async () => {
    const calls = stubFetch();
    const file = join(scratch, 'l2.ee');
    writeFileSync(file, 'ciphertext');

    await storeWorkload({
      filePath: file,
      hash: 'h'.repeat(64),
      controlPlane: 'https://cp.example.com',
      token: 't',
      params: { encryptionLevel: 'level2' },
      secret: 'a'.repeat(64),
      logger: { info() {} },
    });

    assert.equal(
      calls[0].opts.headers['X-EE-Workload-Secret'],
      'a'.repeat(64),
      'Level 2 upload must carry the secret or the workload is undecryptable',
    );
  });

  // A query string is the part of a request proxies, access logs and traces
  // record by default. The server still accepts ?secret= for older CLIs, which
  // is exactly why it is worth asserting that we never produce it.
  it('never puts the secret in the query string', async () => {
    const calls = stubFetch();
    const file = join(scratch, 'l2-query.ee');
    writeFileSync(file, 'ciphertext');

    await storeWorkload({
      filePath: file,
      hash: 'h'.repeat(64),
      controlPlane: 'https://cp.example.com',
      token: 't',
      params: { encryptionLevel: 'level2' },
      secret: 'b'.repeat(64),
      logger: { info() {} },
    });

    assert.ok(
      !String(calls[0].url).includes('b'.repeat(64)),
      'the secret must not appear in the URL',
    );
    assert.ok(!String(calls[0].url).includes('secret='), 'no secret query param');
  });

  // Level 1 is the opposite contract: the key is the browser's and must reach
  // no server. Sending it here would be #208 again, one layer out.
  it('sends no secret header when none is given', async () => {
    const calls = stubFetch();
    const file = join(scratch, 'l1.ee');
    writeFileSync(file, 'ciphertext');

    await storeWorkload({
      filePath: file,
      hash: 'h'.repeat(64),
      controlPlane: 'https://cp.example.com',
      token: 't',
      params: { encryptionLevel: 'level1' },
      logger: { info() {} },
    });

    assert.equal(
      calls[0].opts.headers['X-EE-Workload-Secret'],
      undefined,
      'a Level 1 key must never be sent to the control plane',
    );
  });
});

/**
 * The producer side of #262.
 *
 * The tests above prove storeWorkload sends the header when it is given one.
 * They say nothing about whether anyone gives it one, and that was the actual
 * defect: both call sites built a Level 2 upload and passed no secret at all.
 * A test that stops at the transport would have stayed green through the whole
 * bug.
 *
 * ee-builder is stubbed through the `builderPath` option the public API already
 * exposes, so these drive the real astro.js and deploy.js paths rather than a
 * reimplementation of them.
 */
describe('Level 2 secret reaches the upload from both callers', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'ee-producer-test-'));
  after(() => rmSync(projectDir, { recursive: true, force: true }));

  const SECRET = 'c'.repeat(64);
  const SALT = 'd'.repeat(64);
  const HASH = 'e'.repeat(64);

  /** A stand-in for ee-builder that emits the output runBuilder parses. */
  function fakeBuilder() {
    const bin = join(projectDir, 'fake-ee-builder');
    writeFileSync(
      bin,
      `#!/bin/sh\n` +
        `out=""\n` +
        `while [ $# -gt 0 ]; do [ "$1" = "-out" ] && out="$2"; shift; done\n` +
        `[ -n "$out" ] && printf 'ciphertext' > "$out"\n` +
        `echo "Content hash: ${HASH}"\n` +
        `echo "Secret: ${SECRET}"\n` +
        `echo "Salt: ${SALT}"\n` +
        `echo "Files: 1"\n`,
      { mode: 0o755 },
    );
    return bin;
  }

  it('deploySite sends it for a Level 2 site', async () => {
    const calls = stubFetch();
    const site = join(projectDir, 'dist');
    mkdirSync(site, { recursive: true });
    writeFileSync(join(site, 'index.html'), '<html></html>');

    const { deploySite } = await import('../src/deploy.js');
    await deploySite({
      dir: site,
      domain: 'example.com',
      level: 2,
      controlPlane: 'https://cp.example.com',
      token: 't',
      builderPath: fakeBuilder(),
      cacheDir: join(projectDir, 'cache'),
      logger: { info() {} },
    });

    assert.equal(
      calls[0].opts.headers['X-EE-Workload-Secret'],
      SECRET,
      'a Level 2 site deploy forwarded no secret at all before #262',
    );
  });

  it('the Astro workload path sends it, and derives no key for Level 2', async () => {
    const calls = stubFetch();
    const root = join(projectDir, 'astro');
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'assets', 'a.txt'), 'content');

    const eeCdn = (await import('../src/astro.js')).default;
    const integration = eeCdn({
      workloads: [{ name: 'w', src: 'assets', level: 2 }],
      builderPath: 'fake-ee-builder-astro',
      controlPlane: 'https://cp.example.com',
      token: 't',
      outputFile: 'workloads.json',
      cacheFile: '.cache.json',
    });
    writeFileSync(
      join(root, 'fake-ee-builder-astro'),
      readFileSync(fakeBuilder(), 'utf8'),
      { mode: 0o755 },
    );

    const logger = { info() {}, warn() {} };
    integration.hooks['astro:config:setup']({
      config: { root: pathToFileURL(`${root}/`), build: {} },
      logger,
    });
    await integration.hooks['astro:build:start']({ logger });

    assert.equal(
      calls[0].opts.headers['X-EE-Workload-Secret'],
      SECRET,
      'the sub-workload upload must carry the Level 2 secret',
    );

    // storeWorkload was also not imported here, so this path threw a
    // ReferenceError before it ever reached the network.
    const written = JSON.parse(readFileSync(join(root, 'workloads.json'), 'utf8'));
    assert.equal(written.w.level, 2);
    assert.equal(
      written.w.key,
      undefined,
      'Level 2 must derive no key — html.js writes any key it is handed into the page',
    );
  });
});

/**
 * The cache must not be a way around the secret.
 *
 * Both of these came from review of the first version of this change, and both
 * are the same failure the change exists to prevent, reached from a direction
 * the original fix did not cover: the workload is stored encrypted and the
 * control plane never learns the key, while the build reports success.
 */
describe('#262 regressions reachable around the upload', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'ee-cache-bypass-'));
  after(() => rmSync(projectDir, { recursive: true, force: true }));

  const SECRET = 'c'.repeat(64);

  function builderAt(dir, hash) {
    const bin = join(dir, 'builder');
    writeFileSync(
      bin,
      `#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do [ "$1" = "-out" ] && out="$2"; shift; done\n` +
        `[ -n "$out" ] && printf 'x' > "$out"\n` +
        `echo "Content hash: ${hash}"\necho "Secret: ${SECRET}"\necho "Salt: ${'d'.repeat(64)}"\necho "Files: 1"\n`,
      { mode: 0o755 },
    );
    return bin;
  }

  async function runAstro(root, level, extra = {}) {
    const eeCdn = (await import('../src/astro.js')).default;
    const integration = eeCdn({
      workloads: [{ name: 'w', src: 'assets', level }],
      builderPath: 'builder',
      controlPlane: 'https://cp.example.com',
      token: 't',
      deploy: { domain: 'example.com' },
      outputFile: 'workloads.json',
      cacheFile: '.cache.json',
      ...extra,
    });
    const logger = { info() {}, warn() {} };
    integration.hooks['astro:config:setup']({
      config: { root: pathToFileURL(`${root}/`), build: {} },
      logger,
    });
    await integration.hooks['astro:build:start']({ logger });
  }

  // Same name, same bytes, different level. The cache key ignored the level,
  // and the Level 1 run left a key behind that satisfied the reuse condition —
  // so the Level 2 build was skipped, and with it the upload carrying the
  // secret. The fix to upload.js is useless if the upload never happens.
  it('rebuilds and re-uploads when a workload moves from Level 1 to Level 2', async () => {
    const root = join(projectDir, 'switch');
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'assets', 'a.txt'), 'content');
    builderAt(root, 'a'.repeat(64));

    const first = stubFetch();
    await runAstro(root, 1, first);
    assert.equal(first.length, 1, 'level 1 build uploads');
    assert.equal(first[0].opts.headers['X-EE-Workload-Secret'], undefined);

    const second = stubFetch();
    await runAstro(root, 2, second);
    assert.equal(
      second.length,
      1,
      'switching to Level 2 must not be satisfied by the Level 1 cache entry',
    );
    assert.equal(
      second[0].opts.headers['X-EE-Workload-Secret'],
      SECRET,
      'the Level 2 rebuild must register its secret',
    );
  });

  // Reverting the reuse guard is invisible to any correctness assertion --
  // rebuilding produces the right answer, just slowly -- so it is pinned by the
  // build timestamp. Level 2 stores no key, so a guard that demands one would
  // mean Level 2 never hits the cache at all.
  it('still reuses an unchanged Level 2 build rather than repackaging', async () => {
    const root = join(projectDir, 'l2-reuse');
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'assets', 'a.txt'), 'content');
    builderAt(root, 'e'.repeat(64));

    stubFetch();
    await runAstro(root, 2);
    const cache1 = JSON.parse(readFileSync(join(root, '.cache.json'), 'utf8'));
    const key = Object.keys(cache1)[0];

    stubFetch();
    await runAstro(root, 2);
    const cache2 = JSON.parse(readFileSync(join(root, '.cache.json'), 'utf8'));
    assert.equal(
      cache2[key].builtAt,
      cache1[key].builtAt,
      'an unchanged Level 2 workload must hit the cache',
    );
  });

  // A build that did not upload still populates the cache. If the next build
  // takes that hit it returns before the upload, and since the .ee is deleted
  // after every build there is nothing left to send -- so the secret is never
  // registered and no error is raised.
  it('does not let a never-uploaded cache entry skip the upload', async () => {
    const root = join(projectDir, 'cached-not-uploaded');
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'assets', 'a.txt'), 'content');
    builderAt(root, 'f'.repeat(64));

    stubFetch();
    await runAstro(root, 2, { upload: false });

    const calls = stubFetch();
    await runAstro(root, 2);
    assert.equal(calls.length, 1, 'the workload must still be uploaded');
    assert.equal(calls[0].opts.headers['X-EE-Workload-Secret'], SECRET);
  });

  // ee-builder's secret and salt are scraped out of its stdout, so a missing
  // line or a changed format yields null. Uploading anyway at Level 2 sends no
  // header and stores ciphertext nobody can read.
  it('deploySite refuses to upload a Level 2 workload with no secret', async () => {
    const root = join(projectDir, 'no-secret');
    const site = join(root, 'dist');
    mkdirSync(site, { recursive: true });
    writeFileSync(join(site, 'index.html'), '<html></html>');
    const bin = join(root, 'builder');
    writeFileSync(
      bin,
      `#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do [ "$1" = "-out" ] && out="$2"; shift; done\n` +
        `[ -n "$out" ] && printf 'x' > "$out"\n` +
        `echo "Content hash: ${'b'.repeat(64)}"\necho "Files: 1"\n`,
      { mode: 0o755 },
    );

    const calls = stubFetch();
    const { deploySite } = await import('../src/deploy.js');
    await assert.rejects(
      () =>
        deploySite({
          dir: site,
          domain: 'example.com',
          level: 2,
          controlPlane: 'https://cp.example.com',
          token: 't',
          builderPath: bin,
          cacheDir: join(root, 'cache'),
          logger: { info() {} },
        }),
      /no secret\/salt/,
    );
    assert.equal(calls.length, 0, 'nothing may be uploaded without the secret');
  });
});
