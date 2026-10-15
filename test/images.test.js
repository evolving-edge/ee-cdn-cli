/**
 * Image conversion through cdn-cli (#570): which arguments reach ee-builder,
 * the refusal of a builder too old for them, a cached "latest" checked
 * against the checksum published beside it, and where ee-builder's output
 * goes.
 *
 * ee-builder is stubbed by small shell scripts that record their arguments,
 * through the builderPath option the public API already has, so these drive
 * the real deploy.js, astro.js and CLI paths.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, afterEach, describe, it } from 'node:test';

import {
  builderArgs,
  builderImageFlags,
  cachedBuilderName,
  ensureBuilder,
  imageOptions,
  requireImageSupport,
} from '../src/builder.js';
import { deploySite } from '../src/deploy.js';

const scratch = mkdtempSync(join(tmpdir(), 'ee-images-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = (name) => {
  const d = join(scratch, `${name}-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const quiet = { info() {}, warn() {} };
const HASH = 'e'.repeat(64);
const CLI = fileURLToPath(new URL('../bin/ee-deploy.js', import.meta.url));

/**
 * A stand-in for ee-builder. It writes its arguments, one per line, to
 * argsFile, answers -h with Go's usage listing (with or without the image
 * flags), and prints the summary runBuilder parses.
 */
function fakeBuilder(dir, { imageFlags = true } = {}) {
  const bin = join(dir, 'fake-ee-builder');
  const argsFile = join(dir, 'args.txt');
  const usage = [
    'Usage of ee-builder:',
    '  -domain string',
    '    \tDomain for workload',
    ...(imageFlags ? ['  -image-hosts string', '  -image-report string', '  -images string'] : []),
    '  -version',
    '    \tPrint the version, the image pipeline version and its encoders, then exit',
  ].join('\\n');
  writeFileSync(
    bin,
    `#!/bin/sh\n` +
      `if [ "$1" = "-h" ]; then printf '${usage}\\n' >&2; exit 0; fi\n` +
      `if [ "$1" = "-version" ]; then echo "ee-builder test images:1 webp(x) avif(y)"; exit 0; fi\n` +
      `printf '%s\\n' "$@" > "${argsFile}"\n` +
      `out=""\n` +
      `while [ $# -gt 0 ]; do [ "$1" = "-out" ] && out="$2"; shift; done\n` +
      `[ -n "$out" ] && printf 'workload' > "$out"\n` +
      `echo "Content hash: ${HASH}"\n` +
      `echo "Files: 1"\n`,
    { mode: 0o755 },
  );
  return { bin, args: () => (existsSync(argsFile) ? readFileSync(argsFile, 'utf8').trim().split('\n') : null) };
}

function site(dir) {
  const s = join(dir, 'site');
  mkdirSync(s, { recursive: true });
  writeFileSync(join(s, 'index.html'), '<img src="/a.jpg">');
  return s;
}

/** The value after flag in an argument list, or undefined. */
const after_ = (args, flag) => {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
};

describe('ee-builder arguments for image conversion (#570)', () => {
  it('always passes the domain, and nothing image-related unless asked', () => {
    const args = builderArgs({ src: '/s', out: '/o.ee', level: 0, domain: 'blog.example.com' });
    assert.deepEqual(args, ['-src', '/s', '-out', '/o.ee', '-level', '0', '-domain', 'blog.example.com']);
  });

  it('passes the format, the hosts joined by commas and the report', () => {
    const images = imageOptions({ images: 'webp', imageHosts: ['www.example.com', ' cdn.example.com '], imageReport: '/r.json' });
    const args = builderArgs({ src: '/s', out: '/o.ee', level: 1, domain: 'example.com', images });
    assert.deepEqual(args.slice(6), [
      '-domain', 'example.com',
      '-images', 'webp',
      '-image-hosts', 'www.example.com,cdn.example.com',
      '-image-report', '/r.json',
    ]);
  });

  it('passes "off" so it can override ee.jsonc, and hosts alone without a format', () => {
    assert.deepEqual(builderArgs({ src: '/s', out: '/o', level: 0, images: imageOptions({ images: 'off' }) }).slice(6), ['-images', 'off']);
    assert.deepEqual(builderArgs({ src: '/s', out: '/o', level: 0, images: imageOptions({ imageHosts: ['a.example'] }) }).slice(6), ['-image-hosts', 'a.example']);
  });

  it('checks the options before anything runs', () => {
    assert.equal(imageOptions({}), null);
    assert.equal(imageOptions({ imageHosts: [' ', ''] }), null);
    assert.throws(() => imageOptions({ images: 'jpegxl' }), /webp, avif or off/);
    assert.throws(() => imageOptions({ imageHosts: ['a.example,b.example'] }), /not a host name/);
    assert.throws(() => imageOptions({ imageHosts: ['https://a.example/'] }), /not a host name/);
    assert.equal(imageOptions({ imageReport: 'out/r.json' }).report, resolve(process.cwd(), 'out/r.json'));
  });
});

describe('a builder too old for image options (#570)', () => {
  it('reads the image flags from -h, not the version', () => {
    assert.deepEqual(builderImageFlags(fakeBuilder(fresh('v')).bin), ['-images', '-image-hosts', '-image-report']);
    // Shaped like the builder published from 19a3771: -version already says
    // images:1, but the flags are not there.
    const published = fakeBuilder(fresh('v'), { imageFlags: false }).bin;
    assert.deepEqual(builderImageFlags(published), []);
    assert.throws(() => requireImageSupport(published, 'HINT'), /too old to convert images: it has no -images, -image-hosts, -image-report.*HINT/s);
    requireImageSupport(fakeBuilder(fresh('v')).bin, 'HINT');
  });

  it('refuses before packaging when image options are given', async () => {
    const d = fresh('old');
    const fb = fakeBuilder(d, { imageFlags: false });
    await assert.rejects(
      deploySite({ dir: site(d), domain: 'example.com', dryRun: true, builderPath: fb.bin, cacheDir: join(d, 'c'), images: 'webp', logger: quiet }),
      /too old to convert images.*--builder/s,
    );
    assert.equal(fb.args(), null, 'the old builder must not have been run to package');
  });

  it('refuses when only ee.jsonc turns conversion on, unless an option turns it off (4288790956)', async () => {
    const d = fresh('old-config');
    const fb = fakeBuilder(d, { imageFlags: false });
    const s = site(d);
    writeFileSync(join(s, 'ee.jsonc'), '{\n  // photos\n  "images": "webp",\n}\n');
    await assert.rejects(
      deploySite({ dir: s, domain: 'example.com', dryRun: true, builderPath: fb.bin, cacheDir: join(d, 'c'), logger: quiet }),
      /ee\.jsonc line 3 turns image conversion on, but ee-builder .* too old.*images: "off"/s,
    );
    assert.equal(fb.args(), null, 'the old builder must not have been run to package');
    // "off" from an option overrides ee.jsonc; an old builder then fails on
    // the flag itself, so the option is refused the same way.
    await assert.rejects(
      deploySite({ dir: s, domain: 'example.com', dryRun: true, builderPath: fb.bin, cacheDir: join(d, 'c'), images: 'off', logger: quiet }),
      /too old to convert images/,
    );
    // A "//" inside a string is not a comment: the setting after it counts.
    writeFileSync(join(s, 'ee.jsonc'), '{ "domain": "https://example.com", "images": "webp" }\n');
    await assert.rejects(
      deploySite({ dir: s, domain: 'example.com', dryRun: true, builderPath: fb.bin, cacheDir: join(d, 'c'), logger: quiet }),
      /ee\.jsonc line 1 turns image conversion on/,
    );
    // An object form that turns it on is refused too.
    writeFileSync(join(s, 'ee.jsonc'), '{ "name": "x",\n  "images": { "format": "avif", "quality": 50 } }\n');
    await assert.rejects(
      deploySite({ dir: s, domain: 'example.com', dryRun: true, builderPath: fb.bin, cacheDir: join(d, 'c'), logger: quiet }),
      /ee\.jsonc line 2 turns image conversion on/,
    );
    // Read as ee-builder reads it (4288854484): "off", an object with
    // format "off", a commented-out setting, the text inside a string, and no
    // key at all need no probe.
    for (const body of [
      '{ "images": "off" }\n',
      '{ "images": { "format": "off" } }\n',
      '{\n  // "images": "webp",\n  /* "images": "avif" */\n  "name": "x",\n}\n',
      '{ "name": "say \\"images\\": \\"webp\\" here" }\n',
      '{ "name": "x" }\n',
    ]) {
      writeFileSync(join(s, 'ee.jsonc'), body);
      const r = await deploySite({ dir: s, domain: 'example.com', dryRun: true, builderPath: fb.bin, cacheDir: join(d, 'c'), logger: quiet });
      rmSync(r.workloadPath, { force: true });
      assert.equal(r.hash, HASH);
    }
  });

  it('still packages a site without image options, passing the domain', async () => {
    const d = fresh('old-plain');
    const fb = fakeBuilder(d, { imageFlags: false });
    const r = await deploySite({ dir: site(d), domain: 'example.com', dryRun: true, builderPath: fb.bin, cacheDir: join(d, 'c'), logger: quiet });
    rmSync(r.workloadPath, { force: true });
    assert.equal(r.hash, HASH);
    assert.equal(after_(fb.args(), '-domain'), 'example.com');
    assert.ok(!fb.args().includes('-images'));
  });

  it('passes every option to a builder that has image support', async () => {
    const d = fresh('new');
    const fb = fakeBuilder(d);
    const r = await deploySite({
      dir: site(d), domain: 'example.com', dryRun: true, builderPath: fb.bin, cacheDir: join(d, 'c'),
      images: 'avif', imageHosts: ['www.example.com', 'img.example.com'], imageReport: join(d, 'r.json'), logger: quiet,
    });
    rmSync(r.workloadPath, { force: true });
    const args = fb.args();
    assert.equal(after_(args, '-domain'), 'example.com');
    assert.equal(after_(args, '-images'), 'avif');
    assert.equal(after_(args, '-image-hosts'), 'www.example.com,img.example.com');
    assert.equal(after_(args, '-image-report'), join(d, 'r.json'));
  });
});

describe('the CLI and the Astro integration pass the image options (#570)', () => {
  it('ee-deploy: --images, a repeated --image-host and --image-report reach ee-builder', () => {
    const d = fresh('cli');
    const fb = fakeBuilder(d);
    const r = spawnSync(process.execPath, [
      CLI, site(d), '--domain', 'example.com', '--dry-run', '--builder', fb.bin, '--cache-dir', join(d, 'c'),
      '--images', 'webp', '--image-host', 'www.example.com', '--image-host', 'cdn.example.com', '--image-report', 'report.json',
    ], { cwd: d, encoding: 'utf8', env: { ...process.env, TMPDIR: d } });
    assert.equal(r.status, 0, r.stderr);
    const args = fb.args();
    assert.equal(after_(args, '-domain'), 'example.com');
    assert.equal(after_(args, '-images'), 'webp');
    assert.equal(after_(args, '-image-hosts'), 'www.example.com,cdn.example.com');
    assert.equal(after_(args, '-image-report'), join(d, 'report.json'));
  });

  it('ee-deploy: an unknown format is a usage error', () => {
    const d = fresh('cli-bad');
    const r = spawnSync(process.execPath, [CLI, site(d), '--domain', 'example.com', '--dry-run', '--images', 'gif'], { cwd: d, encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--images must be webp, avif or off/);
  });

  it('Astro: deploy.images, imageHosts and imageReport reach ee-builder for the site', async () => {
    const root = fresh('astro');
    const fb = fakeBuilder(root);
    const dist = site(root);
    const eeCdn = (await import('../src/astro.js')).default;
    const integration = eeCdn({
      deploy: { domain: 'example.com', images: 'webp', imageHosts: ['www.example.com'], imageReport: 'reports/images.json' },
      builderPath: 'fake-ee-builder',
      dryRun: true,
    });
    integration.hooks['astro:config:setup']({ config: { root: pathToFileURL(`${root}/`), build: {} }, logger: quiet });
    // A dry run leaves its workload in the temp folder; keep it in scratch.
    const tmp = process.env.TMPDIR;
    process.env.TMPDIR = root;
    try {
      await integration.hooks['astro:build:done']({ dir: pathToFileURL(`${dist}/`), logger: quiet });
    } finally {
      if (tmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = tmp;
    }
    const args = fb.args();
    assert.equal(after_(args, '-domain'), 'example.com');
    assert.equal(after_(args, '-images'), 'webp');
    assert.equal(after_(args, '-image-hosts'), 'www.example.com');
    assert.equal(after_(args, '-image-report'), join(root, 'reports', 'images.json'));
  });
});

describe('where ee-builder output goes (#570)', () => {
  it('stderr reaches the terminal, stdout is parsed, and stdin is closed', () => {
    const d = fresh('stdio');
    const bin = join(d, 'b');
    writeFileSync(
      bin,
      `#!/bin/sh\n` +
        `if read line; then echo "stdin:$line" >&2; else echo "stdin-closed" >&2; fi\n` +
        `echo "Images: 1 of 1 converted (REPORT-ON-STDERR)" >&2\n` +
        `echo "Content hash: ${HASH}"\n`,
      { mode: 0o755 },
    );
    const script = `import { runBuilder } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../src/builder.js', import.meta.url))).href)};\n` +
      `const r = runBuilder(${JSON.stringify(bin)}, { src: 's', out: 'o', level: 0 });\n` +
      `process.stdout.write('parsed:' + r.hash);\n`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { input: 'LEAKED\n', encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /REPORT-ON-STDERR/, 'ee-builder stderr must reach the terminal, not be captured');
    assert.match(r.stderr, /stdin-closed/, 'ee-builder must not read the caller\'s stdin');
    assert.equal(r.stdout, `parsed:${HASH}`);
  });
});

describe('a cached latest ee-builder against its published checksum (#570)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const digest = (s) => createHash('sha256').update(Buffer.from(s)).digest('hex');
  const key = `${{ linux: 'linux', darwin: 'darwin', win32: 'windows' }[process.platform]}-${{ x64: 'amd64', arm64: 'arm64' }[process.arch]}`;

  /** A control plane whose latest is `bytes`, with or without a .sha256. */
  function serve(bytes, { sidecar = true } = {}) {
    const asked = [];
    globalThis.fetch = async (url) => {
      asked.push(String(url));
      if (String(url).endsWith('.sha256')) {
        return sidecar ? new Response(`${digest(bytes)}\n`) : new Response('not found', { status: 404 });
      }
      return new Response(Buffer.from(bytes));
    };
    return asked;
  }
  function cache(d, bytes) {
    const c = join(d, 'cache');
    mkdirSync(c, { recursive: true });
    const p = join(c, cachedBuilderName('latest', key, key.split('-')[0]));
    writeFileSync(p, bytes, { mode: 0o755 });
    return p;
  }
  const opts = (d, extra = {}) => ({ controlPlane: 'https://cp.example', version: 'latest', cacheDir: join(d, 'cache'), lockfilePath: null, logger: quiet, ...extra });

  it('replaces a stale cached copy when nothing pins it', async () => {
    const d = fresh('stale');
    const p = cache(d, 'builder old');
    const asked = serve('builder new');
    assert.equal(readFileSync(await ensureBuilder(opts(d)), 'utf8'), 'builder new');
    assert.equal(readFileSync(p, 'utf8'), 'builder new');
    assert.ok(asked.some((u) => !u.endsWith('.sha256')), 'the new binary was downloaded');
  });

  it('keeps a cached copy that matches, without downloading', async () => {
    const d = fresh('fresh');
    cache(d, 'builder new');
    const asked = serve('builder new');
    await ensureBuilder(opts(d));
    assert.deepEqual(asked.filter((u) => !u.endsWith('.sha256')), []);
  });

  it('keeps a pinned copy and names the newer release', async () => {
    const d = fresh('pinned');
    const p = cache(d, 'builder old');
    const lock = join(d, 'lock.json');
    writeFileSync(lock, JSON.stringify({ [`latest:${key}`]: digest('builder old') }));
    const asked = serve('builder new');
    const warned = [];
    await ensureBuilder(opts(d, { lockfilePath: lock, logger: { info() {}, warn: (m) => warned.push(m) } }));
    assert.equal(readFileSync(p, 'utf8'), 'builder old');
    assert.deepEqual(asked.filter((u) => !u.endsWith('.sha256')), []);
    assert.match(warned.join('\n'), /newer ee-builder latest is published.*Delete its "latest:/s);
  });

  it('refuses a download that does not match the published checksum', async () => {
    const d = fresh('tampered');
    globalThis.fetch = async (url) =>
      String(url).endsWith('.sha256') ? new Response(digest('builder new')) : new Response(Buffer.from('tampered'));
    await assert.rejects(ensureBuilder(opts(d)), /published checksum mismatch/);
    assert.equal(existsSync(join(d, 'cache', cachedBuilderName('latest', key, key.split('-')[0]))), false);
  });

  it('keeps the binary another project pins when one project moves to a newer latest (4288790903)', async () => {
    const d = fresh('shared');
    const lockA = join(d, 'a.lock.json');
    const lockB = join(d, 'b.lock.json');
    serve('builder A');
    const first = await ensureBuilder(opts(d, { lockfilePath: lockA }));
    assert.equal(readFileSync(first, 'utf8'), 'builder A');
    // A newer latest is published; project B, which pins nothing yet, moves to it.
    serve('builder B');
    assert.equal(readFileSync(await ensureBuilder(opts(d, { lockfilePath: lockB })), 'utf8'), 'builder B');
    // Project A still pins release A, and still has it, without downloading.
    const asked = serve('builder B');
    const again = await ensureBuilder(opts(d, { lockfilePath: lockA, logger: { info() {}, warn() {} } }));
    assert.equal(readFileSync(again, 'utf8'), 'builder A');
    assert.deepEqual(asked.filter((u) => !u.endsWith('.sha256')), []);
    // And B keeps B.
    assert.equal(readFileSync(await ensureBuilder(opts(d, { lockfilePath: lockB })), 'utf8'), 'builder B');
    // A path handed back stays the binary that was checked, whatever replaces
    // the plain name afterwards (4288854448).
    assert.equal(readFileSync(first, 'utf8'), 'builder A');
    assert.equal(readFileSync(again, 'utf8'), 'builder A');
  });

  it('keeps a pinned binary that an older cdn-cli cached under the plain name only', async () => {
    const d = fresh('legacy');
    cache(d, 'builder A');
    const lockA = join(d, 'a.lock.json');
    writeFileSync(lockA, JSON.stringify({ [`latest:${key}`]: digest('builder A') }));
    serve('builder B');
    assert.equal(readFileSync(await ensureBuilder(opts(d, { lockfilePath: join(d, 'b.lock.json') })), 'utf8'), 'builder B');
    const asked = serve('builder B');
    const again = await ensureBuilder(opts(d, { lockfilePath: lockA, logger: { info() {}, warn() {} } }));
    assert.equal(readFileSync(again, 'utf8'), 'builder A');
    assert.deepEqual(asked.filter((u) => !u.endsWith('.sha256')), []);
  });

  it('uses the cache when no checksum is published or reachable', async () => {
    const d = fresh('offline');
    const p = cache(d, 'builder old');
    const asked = serve('builder new', { sidecar: false });
    assert.equal(readFileSync(await ensureBuilder(opts(d)), 'utf8'), 'builder old');
    assert.equal(readFileSync(p, 'utf8'), 'builder old');
    assert.deepEqual(asked.filter((u) => !u.endsWith('.sha256')), []);
    globalThis.fetch = async () => {
      throw new Error('offline');
    };
    assert.equal(readFileSync(await ensureBuilder(opts(d)), 'utf8'), 'builder old');
  });
});
