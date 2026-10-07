/**
 * #394-#396, #404, #421: the static-site options. Pragmas written into
 * _redirects, output-folder detection, and pinning ee-builder.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';

import { ensurePragmas } from '../src/pragmas.js';
import { detectOutputDir } from '../src/detect.js';
import { ensureBuilder } from '../src/builder.js';

const scratch = mkdtempSync(join(tmpdir(), 'ee-ssg-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const dir = (files = {}) => {
  const d = join(scratch, String(n++));
  mkdirSync(d, { recursive: true });
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(d, p, '..'), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  return d;
};
const quiet = { info() {}, warn() {} };
const redirects = (d) => readFileSync(join(d, '_redirects'), 'utf8');

describe('ensurePragmas (#395)', () => {
  it('creates _redirects when there is none', () => {
    const d = dir({ 'index.html': 'x' });
    ensurePragmas(d, { trailingSlash: true }, quiet);
    assert.equal(redirects(d), '# ee:trailing-slash on\n');
  });

  it('adds the pragma at the top and leaves the rules alone', () => {
    const d = dir({ _redirects: '/old /new 301\n/a/* /b/:splat 302\n' });
    ensurePragmas(d, { trailingSlash: true }, quiet);
    assert.equal(redirects(d), '# ee:trailing-slash on\n/old /new 301\n/a/* /b/:splat 302\n');
  });

  it('leaves a file that already says on untouched', () => {
    const body = '/x /y 301\n# ee:trailing-slash on\n';
    const d = dir({ _redirects: body });
    ensurePragmas(d, { trailingSlash: true }, quiet);
    assert.equal(redirects(d), body);
  });

  it("keeps the site's own off, and warns", () => {
    const body = '# ee:trailing-slash off\n/x /y 301\n';
    const d = dir({ _redirects: body });
    const warned = [];
    ensurePragmas(d, { trailingSlash: true }, { info() {}, warn: (m) => warned.push(m) });
    assert.equal(redirects(d), body);
    assert.match(warned[0], /keeping the site's "# ee:trailing-slash off"/);
  });

  it('writes both flags', () => {
    const d = dir({});
    ensurePragmas(d, { trailingSlash: true, cleanUrls: true }, quiet);
    assert.equal(redirects(d), '# ee:trailing-slash on\n# ee:clean-urls on\n');
  });

  it('does nothing without a flag', () => {
    const d = dir({});
    ensurePragmas(d, {}, quiet);
    assert.equal(existsSync(join(d, '_redirects')), false);
  });
});

describe('detectOutputDir (#404)', () => {
  const pkg = (deps) => JSON.stringify({ dependencies: deps });
  const cases = [
    ['Astro', { 'package.json': pkg({ astro: '4' }), 'dist/index.html': 'x' }, 'dist'],
    ['Nuxt', { 'package.json': pkg({ nuxt: '3' }), '.output/public/index.html': 'x' }, '.output/public'],
    ['Docusaurus', { 'package.json': pkg({ '@docusaurus/core': '3' }), 'build/index.html': 'x' }, 'build'],
    ['VitePress', { 'package.json': pkg({ vitepress: '1' }), 'docs/.vitepress/dist/index.html': 'x' }, 'docs/.vitepress/dist'],
    ['Eleventy', { 'package.json': pkg({ '@11ty/eleventy': '3' }), '_site/index.html': 'x' }, '_site'],
    ['Hugo', { 'hugo.toml': 'title = "x"', 'public/index.html': 'x' }, 'public'],
    ['Jekyll', { '_config.yml': 'x', Gemfile: 'gem "jekyll"', '_site/index.html': 'x' }, '_site'],
    ['MkDocs', { 'mkdocs.yml': 'site_name: x', 'site/index.html': 'x' }, 'site'],
    ['mdBook', { 'book.toml': '[book]', 'book/index.html': 'x' }, 'book'],
    ['Zola', { 'config.toml': 'base_url = "https://x"', 'public/index.html': 'x' }, 'public'],
    ['Next.js', { 'package.json': pkg({ next: '15' }), 'next.config.mjs': "export default { output: 'export' }", 'out/index.html': 'x' }, 'out'],
    ['Vite', { 'package.json': JSON.stringify({ devDependencies: { vite: '6' } }), 'dist/index.html': 'x' }, 'dist'],
  ];
  for (const [label, files, out] of cases) {
    it(`finds ${label}'s ${out}`, () => {
      const got = detectOutputDir(dir(files));
      assert.equal(got.label.split(' ')[0], label.split(' ')[0]);
      assert.equal(got.rel, out);
    });
  }

  it("never takes Astro's public/ source folder", () => {
    const d = dir({ 'package.json': pkg({ astro: '4' }), 'public/favicon.ico': 'x', 'public/index.html': 'x' });
    assert.throws(() => detectOutputDir(d), /dist\/index\.html doesn't exist/);
  });

  it('refuses two generators', () => {
    const d = dir({ 'package.json': pkg({ astro: '4' }), 'mkdocs.yml': 'x', 'dist/index.html': 'x' });
    assert.throws(() => detectOutputDir(d), /more than one generator \(Astro, MkDocs\)/);
  });

  it('refuses no generator', () => {
    assert.throws(() => detectOutputDir(dir({ 'index.html': 'x' })), /no known site generator/);
  });

  it('refuses Next.js without a static export', () => {
    const d = dir({ 'package.json': pkg({ next: '15' }), 'out/index.html': 'x' });
    assert.throws(() => detectOutputDir(d), /output: 'export'/);
  });
});

describe('pinning ee-builder (#421)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const opts = (version, d) => ({
    controlPlane: 'https://cp.example',
    version,
    lockfilePath: join(d, 'lock.json'),
    cacheDir: join(d, 'cache'),
    logger: quiet,
  });

  it('downloads the pinned version and locks it under that version', async () => {
    const d = dir({});
    const asked = [];
    globalThis.fetch = async (url) => {
      asked.push(url);
      return new Response(Buffer.from('builder v1'));
    };
    await ensureBuilder(opts('ab9da4298ece', d));
    assert.match(asked[0], /\/releases\/ee-builder\/ab9da4298ece\//);
    const lock = JSON.parse(readFileSync(join(d, 'lock.json'), 'utf8'));
    assert.ok(Object.keys(lock).every((k) => k.startsWith('ab9da4298ece:')));
  });

  it('fails when the pinned bytes change', async () => {
    const d = dir({});
    globalThis.fetch = async () => new Response(Buffer.from('builder v1'));
    await ensureBuilder(opts('v1', d));
    rmSync(join(d, 'cache'), { recursive: true, force: true });
    globalThis.fetch = async () => new Response(Buffer.from('tampered'));
    await assert.rejects(ensureBuilder(opts('v1', d)), /checksum mismatch/);
  });

  it('says plainly when a pinned version does not exist', async () => {
    const d = dir({});
    globalThis.fetch = async () => new Response('not found', { status: 404, statusText: 'Not Found' });
    await assert.rejects(ensureBuilder(opts('nope', d)), /version "nope" isn't published/);
  });
});
