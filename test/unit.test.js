import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    assert.equal(it_.name, '@evolving-edge/cdn-cli');
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
