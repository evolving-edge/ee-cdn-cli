import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { computeDirectoryHash, loadCache, saveCache } from '../src/content-hash.js';
import { toKey } from '../src/builder.js';
import eeCdn from '../src/astro.js';
import { transformHtml } from '../src/html.js';

const scratch = mkdtempSync(join(tmpdir(), 'ee-astro-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function fixture(name, files) {
  const root = join(scratch, name);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

describe('computeDirectoryHash', () => {
  it('is stable across identical trees', () => {
    const a = fixture('a', { 'index.html': '<h1>hi</h1>', 'sub/x.txt': 'x' });
    const b = fixture('b', { 'index.html': '<h1>hi</h1>', 'sub/x.txt': 'x' });
    assert.equal(computeDirectoryHash(a), computeDirectoryHash(b));
  });

  it('changes when content changes', () => {
    const a = fixture('c', { 'index.html': '<h1>hi</h1>' });
    const b = fixture('d', { 'index.html': '<h1>ho</h1>' });
    assert.notEqual(computeDirectoryHash(a), computeDirectoryHash(b));
  });

  it('changes when only a filename changes', () => {
    const a = fixture('e', { 'one.txt': 'same' });
    const b = fixture('f', { 'two.txt': 'same' });
    assert.notEqual(computeDirectoryHash(a), computeDirectoryHash(b));
  });
});

describe('cache', () => {
  it('round-trips and tolerates corruption', () => {
    const p = join(scratch, 'cache.json');
    saveCache(p, { 'w:abc': { hash: 'x' } });
    assert.deepEqual(loadCache(p), { 'w:abc': { hash: 'x' } });
    writeFileSync(p, 'not json');
    assert.deepEqual(loadCache(p), {});
    assert.deepEqual(loadCache(join(scratch, 'missing.json')), {});
  });
});

describe('toKey', () => {
  it('is base64url of secret || salt', () => {
    const key = toKey('00'.repeat(32), 'ff'.repeat(32));
    const raw = Buffer.from(key, 'base64url');
    assert.equal(raw.length, 64);
    assert.equal(raw.subarray(0, 32).toString('hex'), '00'.repeat(32));
    assert.equal(raw.subarray(32).toString('hex'), 'ff'.repeat(32));
    assert.ok(!/[+/=]/.test(key), 'must be url-safe');
  });
});

describe('integration shape', () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop };
  const config = (over) => ({
    root: new URL(`file://${scratch}/`),
    build: { format: 'directory' },
    trailingSlash: 'always',
    ...over,
  });

  it('registers the documented hooks', () => {
    const it_ = eeCdn();
    assert.equal(it_.name, '@evolving-edge/ee-cdn-cli');
    assert.deepEqual(Object.keys(it_.hooks).sort(), [
      'astro:build:done',
      'astro:build:start',
      'astro:config:setup',
    ]);
  });

  it("rejects build.format 'file', which would 404 every page on ee-cdn", () => {
    const setup = eeCdn().hooks['astro:config:setup'];
    assert.throws(
      () => setup({ config: config({ build: { format: 'file' } }), logger }),
      /build\.format: 'file' is incompatible/,
    );
  });

  it("warns on trailingSlash 'never' rather than failing", () => {
    const warnings = [];
    const setup = eeCdn().hooks['astro:config:setup'];
    setup({
      config: config({ trailingSlash: 'never' }),
      logger: { ...logger, warn: (m) => warnings.push(m) },
    });
    assert.match(warnings.join('\n'), /trailingSlash: 'never' will 404/);
  });

  it('accepts a conforming config', () => {
    const setup = eeCdn().hooks['astro:config:setup'];
    assert.doesNotThrow(() => setup({ config: config(), logger }));
  });
});

describe('key embedding by encryption level (#262)', () => {
  const htmlDir = mkdtempSync(join(tmpdir(), 'ee-html-test-'));
  after(() => rmSync(htmlDir, { recursive: true, force: true }));

  function build(name, workloads) {
    const file = join(htmlDir, `${name}.html`);
    writeFileSync(
      file,
      '<html><body>' +
        '<img data-ee="/images/photo.svg" data-ee-workload="w" />' +
        '</body></html>',
    );
    return { file, run: () => transformHtml(file, workloads, 'w', null) };
  }

  // The whole point of Level 2: the control plane holds the secret and issues
  // short-lived revocable tokens. A key in the markup hands the browser the
  // long-lived material instead, which is not Level 2 by any definition -- and
  // nothing downstream would report it, because the page renders correctly.
  it('never writes data-ee-key for a Level 2 workload', async () => {
    const { file, run } = build('level2', {
      w: { hash: 'h'.repeat(64), level: 2, key: 'LEAKED-LEVEL-2-KEY' },
    });
    await run();
    const out = readFileSync(file, 'utf8');
    assert.ok(!out.includes('LEAKED-LEVEL-2-KEY'), 'Level 2 key must not reach the page');
    assert.ok(!out.includes('data-ee-key'), 'no data-ee-key attribute at Level 2');
    assert.ok(out.includes('h'.repeat(64)), 'the hash is still resolved');
  });

  // Level 1 is client-side decryption, so the key belongs in the page. Asserted
  // so the fix above cannot be "fixed" into breaking Level 1.
  it('still writes data-ee-key for a Level 1 workload', async () => {
    const { file, run } = build('level1', {
      w: { hash: 'h'.repeat(64), level: 1, key: 'LEVEL-1-KEY' },
    });
    await run();
    const out = readFileSync(file, 'utf8');
    assert.ok(out.includes('data-ee-key="LEVEL-1-KEY"'), 'Level 1 key belongs in the page');
  });

  // Suppressing the write is not the same as enforcing the rule. A key already
  // on the element -- copied from an example, or written by this function on an
  // earlier pass before the workload moved to Level 2 -- is exactly as readable
  // to a browser as one we put there, and the first version of this guard left
  // it untouched.
  it('removes a data-ee-key that was already on a Level 2 element', async () => {
    const file = join(htmlDir, 'stale.html');
    writeFileSync(
      file,
      '<html><body>' +
        '<img data-ee="/a.svg" data-ee-workload="w" data-ee-key="STALE-KEY" />' +
        '</body></html>',
    );
    await transformHtml(file, { w: { hash: 'h'.repeat(64), level: 2 } }, 'w', null);
    const out = readFileSync(file, 'utf8');
    assert.ok(!out.includes('STALE-KEY'), 'an inherited Level 2 key must be removed, not merely not-added');
    assert.ok(!out.includes('data-ee-key'), 'no data-ee-key attribute survives at Level 2');
  });

  // The same removal must not eat a legitimate Level 1 key that the element
  // already carried and that we are about to rewrite anyway.
  it('still ends up with the correct key when Level 1 markup already had one', async () => {
    const file = join(htmlDir, 'l1-existing.html');
    writeFileSync(
      file,
      '<html><body>' +
        '<img data-ee="/a.svg" data-ee-workload="w" data-ee-key="OLD-KEY" />' +
        '</body></html>',
    );
    await transformHtml(file, { w: { hash: 'h'.repeat(64), level: 1, key: 'NEW-KEY' } }, 'w', null);
    const out = readFileSync(file, 'utf8');
    assert.ok(out.includes('data-ee-key="NEW-KEY"'), 'Level 1 key is rewritten');
    assert.ok(!out.includes('OLD-KEY'), 'and the previous one is gone');
  });

  // Entries written by an older build carry no `level`. Those only ever had a
  // key at Level 1, so the absent field must not silently drop it.
  it('treats a missing level as Level 1 for backward compatibility', async () => {
    const { file, run } = build('legacy', {
      w: { hash: 'h'.repeat(64), key: 'LEGACY-KEY' },
    });
    await run();
    assert.ok(readFileSync(file, 'utf8').includes('data-ee-key="LEGACY-KEY"'));
  });
});

describe('sub-workload uploads follow the deploy target (#263)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ee-gate-test-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  function project(name) {
    const dir = join(root, name);
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets', 'a.txt'), 'content');
    writeFileSync(
      join(dir, 'builder'),
      `#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do [ "$1" = "-out" ] && out="$2"; shift; done\n` +
        `[ -n "$out" ] && printf 'x' > "$out"\n` +
        `echo "Content hash: ${'f'.repeat(64)}"\necho "Secret: ${'a'.repeat(64)}"\n` +
        `echo "Salt: ${'b'.repeat(64)}"\necho "Files: 1"\n`,
      { mode: 0o755 },
    );
    return dir;
  }

  async function run(dir, opts = {}) {
    const integration = eeCdn({
      workloads: [{ name: 'w', src: 'assets', level: opts.level ?? 0 }],
      builderPath: 'builder',
      controlPlane: 'https://cp.example.com',
      token: 't',
      outputFile: 'workloads.json',
      cacheFile: '.cache.json',
      ...(opts.deploy ? { deploy: opts.deploy } : {}),
    });
    const logger = { info() {}, warn() {} };
    integration.hooks['astro:config:setup']({
      config: { root: pathToFileURL(`${dir}/`), build: {} },
      logger,
    });
    await integration.hooks['astro:build:start']({ logger });
  }

  // The README promises that omitting `deploy` builds and validates without
  // publishing. Gating on `upload` alone published anyway, and demanded a token
  // to do it -- the one thing the caller had asked not to happen.
  it('does not upload when no deploy target is configured', async () => {
    const dir = project('no-deploy');
    let called = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      called++;
      return { ok: true, status: 200, statusText: 'OK', text: async () => '{}' };
    };
    try {
      await run(dir);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(called, 0, 'no deploy target means no upload');
  });

  it('uploads once a deploy target is configured', async () => {
    const dir = project('with-deploy');
    let called = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      called++;
      return { ok: true, status: 200, statusText: 'OK', text: async () => '{}' };
    };
    try {
      await run(dir, { deploy: { domain: 'example.com' } });
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(called, 1, 'a configured deploy target uploads');
  });

  // The level-in-cache-key fix landed on the Level 2 branch because it was
  // load-bearing there. This is the other direction it protects: a Level 1
  // build must not be handed back for a Level 0 workload, which would serve an
  // encrypted artifact as though it were public.
  it('does not reuse a Level 1 build for a Level 0 workload', async () => {
    const dir = project('level-down');
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '{}',
    });
    try {
      await run(dir, { level: 1, deploy: { domain: 'example.com' } });
      const l1 = JSON.parse(readFileSync(join(dir, 'workloads.json'), 'utf8'));
      assert.ok(l1.w.key, 'the Level 1 build has a key');

      await run(dir, { level: 0, deploy: { domain: 'example.com' } });
      const l0 = JSON.parse(readFileSync(join(dir, 'workloads.json'), 'utf8'));
      assert.equal(l0.w.key, undefined, 'a Level 0 workload must not inherit it');
      assert.equal(l0.w.level, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
