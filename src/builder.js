/**
 * Acquiring and running the `ee-builder` binary.
 *
 * The previous integration required a Go binary sitting at a hardcoded relative
 * path (`../ee-builder/ee-builder`), which only worked for directories inside
 * the ee-cdn monorepo. Nothing outside that tree could use it. We download a
 * released binary from the control plane instead and cache it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { arch as osArch, platform as osPlatform, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const DEFAULT_CONTROL_PLANE = 'https://cp.3dge.app';

/** The cache lookup's file reads; a test swaps them to interleave another deploy. */
export const cacheFs = { existsSync, readFileSync };

/**
 * ee-builder is published for these only. Must match the target loops in
 * .github/workflows/upload-ee-builder.yml.
 */
export const SUPPORTED = new Set([
  'linux-amd64',
  'linux-arm64',
  'darwin-arm64',
  'darwin-amd64',
  'windows-amd64',
]);

/**
 * Where a downloaded builder is cached. Windows can't start a file without
 * an executable extension, so it gets .exe there.
 */
export function cachedBuilderName(version, key, os) {
  return `ee-builder-${version}-${key}${os === 'windows' ? '.exe' : ''}`;
}

function targetTriple() {
  const os = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[osPlatform()];
  const arch = { x64: 'amd64', arm64: 'arm64' }[osArch()];
  if (!os || !arch) {
    throw new Error(
      `Unsupported platform ${osPlatform()}/${osArch()} for ee-builder.`,
    );
  }
  return { os, arch, key: `${os}-${arch}` };
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * The digest the control plane publishes beside a release, or null when there
 * is none or it cannot be fetched. upload-ee-builder.yml writes a `.sha256`
 * next to every ee-builder binary, versioned and latest; older releases have
 * none, and an offline run must still be able to use its cache.
 */
async function publishedDigest(url) {
  try {
    const res = await fetch(`${url}.sha256`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const text = (await res.text()).trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

/**
 * Download (or reuse) the ee-builder binary.
 *
 * Integrity: the first download's digest is written to a lockfile in the
 * project and every later download must match it (trust on first use). Pass
 * `checksum` to pin a known digest explicitly instead. Either is a pin, and a
 * pin always wins.
 *
 * The control plane also publishes a `.sha256` beside each binary. A fresh
 * download must match it, and for "latest", which moves, it is asked for on
 * every run: a cached copy that no longer matches it is stale and is replaced,
 * unless a pin holds it, in which case the pin is kept and the newer release
 * is named, so the caller can choose to move.
 */
export async function ensureBuilder({
  controlPlane = DEFAULT_CONTROL_PLANE,
  version = 'latest',
  checksum = null,
  lockfilePath,
  cacheDir,
  logger,
}) {
  const { os, arch, key } = targetTriple();
  if (!SUPPORTED.has(key)) {
    throw new Error(
      `ee-builder is not published for ${key}. Published targets: ` +
        `${[...SUPPORTED].join(', ')}. Build it from source and pass ` +
        `builderPath instead.`,
    );
  }

  const binPath = join(cacheDir, cachedBuilderName(version, key, os));
  const url = `${controlPlane}/releases/ee-builder/${version}/${os}/${arch}`;
  const expected = checksum ?? readLock(lockfilePath, key, version);
  // undefined: not asked yet. null: asked, and there is none.
  let published = version === 'latest' && !checksum ? await publishedDigest(url) : undefined;

  // The cache is shared by every project on the machine, and each may pin a
  // different release. The plain name holds the copy downloaded last; every
  // copy is also kept under its digest, so a project moving to a newer
  // "latest" never takes away the binary another project's lockfile pins.
  const digestPath = (d) => join(cacheDir, cachedBuilderName(`${version}@${d.slice(0, 16)}`, key, os));
  // Writes through a temp name, so a killed build cannot leave a truncated
  // binary.
  const place = (bytes, dest) => {
    mkdirSync(cacheDir, { recursive: true });
    const tmp = join(cacheDir, `.ee-builder-${process.pid}.part`);
    writeFileSync(tmp, bytes);
    chmodSync(tmp, 0o755);
    renameSync(tmp, dest);
  };
  // A verified binary is handed back under its digest, never the plain name:
  // another deploy on the machine may replace the plain name between this
  // check and the run.
  const keep = (bytes, d) => {
    const p = digestPath(d);
    if (!existsSync(p) || sha256(readFileSync(p)) !== d) place(bytes, p);
    return p;
  };
  const want = expected ?? published ?? null;
  if (want) {
    // The digest name is looked at again last: another deploy may move the
    // plain-name copy there between the first two looks.
    for (const p of [digestPath(want), binPath, digestPath(want)]) {
      if (!cacheFs.existsSync(p)) continue;
      const bytes = cacheFs.readFileSync(p);
      if (sha256(bytes) === want) {
        if (expected && published && published !== expected) {
          logger.warn(
            `A newer ee-builder ${version} is published (sha256 ${published.slice(0, 16)}…), ` +
              `but ${lockfilePath} pins ${expected.slice(0, 16)}…. Delete its ` +
              `"${version}:${key}" entry to move to the newer one.`,
          );
        }
        // A project using a warm cache for the first time pins what it
        // used, as a download would, so a later release cannot switch it.
        if (!checksum && !expected) writeLock(lockfilePath, key, version, want, false, logger);
        return keep(bytes, want);
      }
    }
    if (existsSync(binPath)) {
      if (expected) {
        logger.warn(`No cached ee-builder matches the pinned digest ${expected.slice(0, 16)}…; re-downloading.`);
      } else {
        logger.info(`A newer ee-builder ${version} is published; downloading it.`);
      }
    }
  } else if (existsSync(binPath)) {
    // Nothing pinned and no published digest to compare (offline, or an
    // older release without one): the last download is the best there is.
    const bytes = readFileSync(binPath);
    const have = sha256(bytes);
    if (!checksum) writeLock(lockfilePath, key, version, have, false, logger);
    return keep(bytes, have);
  }

  if (published === undefined) published = await publishedDigest(url);
  logger.info(`Downloading ee-builder from ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404 && version !== 'latest') {
      throw new Error(
        `ee-builder version "${version}" isn't published for ${key}. Check the ` +
          'label in the "Upload ee-builder to CDN" run summary, or use "latest".',
      );
    }
    throw new Error(
      `Failed to download ee-builder (${res.status} ${res.statusText}) from ${url}`,
    );
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const digest = sha256(bytes);

  if (expected && digest !== expected) {
    throw new Error(
      `ee-builder checksum mismatch.\n` +
        `  expected: ${expected}\n` +
        `  received: ${digest}\n` +
        `If the release legitimately changed, update or delete ` +
        `${lockfilePath}. If you did not expect a change, stop and investigate.`,
    );
  }
  if (published && digest !== published) {
    throw new Error(
      `ee-builder published checksum mismatch: the download does not match the ` +
        `.sha256 published beside it.\n` +
        `  published: ${published}\n` +
        `  received:  ${digest}\n` +
        `Retry; if it persists, stop and investigate.`,
    );
  }

  // The copy about to be replaced stays under its own digest: another
  // project may pin it.
  if (existsSync(binPath)) {
    const oldBytes = readFileSync(binPath);
    const old = sha256(oldBytes);
    if (old !== digest) keep(oldBytes, old);
  }
  place(bytes, binPath);
  const kept = keep(bytes, digest);

  if (!checksum) {
    writeLock(lockfilePath, key, version, digest, Boolean(expected), logger);
  }
  logger.info(`ee-builder ready (${(bytes.length / 1e6).toFixed(1)} MB, sha256 ${digest.slice(0, 16)}…)`);
  return kept;
}

function readLock(path, key, version) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'))?.[`${version}:${key}`] ?? null;
  } catch {
    return null;
  }
}

function writeLock(path, key, version, digest, existed, logger) {
  if (!path) return;
  let lock = {};
  if (existsSync(path)) {
    try {
      lock = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      lock = {};
    }
  }
  lock[`${version}:${key}`] = digest;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`);
  if (!existed) {
    logger.info(
      `Pinned ee-builder ${version}/${key} to ${digest.slice(0, 16)}… — commit ` +
        `the lockfile so CI verifies the same binary.`,
    );
  }
}

/** A host name, with a port if it needs one: normalizeImageHost in ee-builder/ee_config.go. */
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/;

/** Image formats ee-builder converts to, and "off" to override ee.jsonc. */
export const IMAGE_FORMATS = new Set(['webp', 'avif', 'off']);

/** The image flags builderArgs passes. ee-builder gained all three at once. */
export const IMAGE_FLAGS = ['-images', '-image-hosts', '-image-report'];

/** The resize flag, which came later than the conversion flags (#571). */
export const MAX_WIDTH_FLAG = '-image-max-width';

/** The widest -image-max-width ee-builder takes (maxResizeWidth). */
export const MAX_IMAGE_WIDTH = 16383;

/**
 * An image width in pixels, from a number or a string of digits, or an error
 * naming what was wrong. ee-builder checks it too; checking here stops a bad
 * value before an Astro build packages anything.
 */
export function parseImageMaxWidth(v) {
  const s = String(v).trim();
  const n = /^[0-9]+$/.test(s) ? Number(s) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGE_WIDTH) {
    throw new Error(`image max width must be a whole number of pixels from 1 to ${MAX_IMAGE_WIDTH} (got "${v}")`);
  }
  return n;
}

/**
 * Check and normalise the image options, or return null when none was given,
 * in which case nothing image-related is passed and ee.jsonc alone decides.
 * The report path is made absolute so it does not depend on where ee-builder
 * runs.
 */
export function imageOptions({ images = null, imageHosts = [], imageReport = null, imageMaxWidth = null } = {}) {
  const hosts = (imageHosts ?? []).map((h) => String(h).trim()).filter(Boolean);
  const unsetWidth = imageMaxWidth == null || String(imageMaxWidth).trim() === '';
  if (images == null && hosts.length === 0 && !imageReport && unsetWidth) return null;
  const maxWidth = unsetWidth ? null : parseImageMaxWidth(imageMaxWidth);
  if (images != null && !IMAGE_FORMATS.has(images)) {
    throw new Error(`images must be webp, avif or off (got "${images}")`);
  }
  for (const h of hosts) {
    // ee-builder's rule, so a host it would refuse fails here, before an
    // Astro build packages anything; it also keeps commas out, since the
    // hosts are joined with them for -image-hosts.
    if (!HOST_RE.test(h.toLowerCase().replace(/\.$/, ''))) {
      throw new Error(`image host "${h}" is not a host name; give the host alone, as in www.example.com`);
    }
  }
  return {
    format: images ?? null,
    hosts,
    report: imageReport ? (isAbsolute(imageReport) ? imageReport : resolve(process.cwd(), imageReport)) : null,
    maxWidth,
  };
}

/**
 * The ee-builder flags image options need: the conversion flags for a format,
 * hosts or a report, and -image-max-width for a width.
 */
export function neededImageFlags(images) {
  if (!images) return [];
  const needed = [];
  if (images.format != null || images.hosts.length || images.report) needed.push(...IMAGE_FLAGS);
  if (images.maxWidth) needed.push(MAX_WIDTH_FLAG);
  return needed;
}

/**
 * The arguments for one ee-builder run. The domain is always passed: with
 * images on, ee-builder counts absolute URLs on it as the site's own, and it
 * changes nothing in a build without them.
 */
export function builderArgs({ src, out, level, domain = null, images = null }) {
  const args = ['-src', src, '-out', out, '-level', String(level)];
  if (domain) args.push('-domain', domain);
  if (images) {
    if (images.format) args.push('-images', images.format);
    if (images.hosts.length) args.push('-image-hosts', images.hosts.join(','));
    if (images.report) args.push('-image-report', images.report);
    if (images.maxWidth) args.push(MAX_WIDTH_FLAG, String(images.maxWidth));
  }
  return args;
}

/**
 * The environment ee-builder runs with: this process's, minus credentials (#832).
 *
 * ee-builder is downloaded at run time and, unless the caller pins
 * --builder-version and commits the lockfile, is whatever was published last.
 * It never needs the deploy token here: the CLI uploads, and builderArgs never
 * passes -upload, the only path in ee-builder that reads EE_CDN_TOKEN. So the
 * token, and anything else named like a credential (GITHUB_TOKEN, NPM_TOKEN,
 * ACTIONS_*_TOKEN, *_SECRET, *_PASSWORD, *_API_KEY), is left out. Everything
 * else is kept, PATH, HOME and the temp and locale variables included, so the
 * builder runs as it did on every platform.
 */
export const BUILDER_ENV_DROPPED = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i;

export function builderEnv(env = process.env) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (BUILDER_ENV_DROPPED.test(name)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * The image flags a builder lists in its usage, which every ee-builder prints
 * for -h. The flags are asked about directly, not the version: the builder
 * published from 19a3771 already reports image pipeline 1 on -version (the
 * encoders came first, in #638) but has none of these flags, which came with
 * #644. The first published builder with them is c64bedcb850a (2026-10-23).
 */
export function builderImageFlags(builderPath) {
  const r = spawnSync(builderPath, ['-h'], {
    encoding: 'utf8',
    env: builderEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
  });
  // A builder that cannot run at all (not executable, timed out) is that,
  // not one without image flags.
  if (r.error) throw new Error(`Could not run ee-builder at ${builderPath} to check its flags: ${r.error.message}`);
  const usage = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // -h exits 0 (Go's flag package since 1.16), so anything else is a failure
  // to report as such, with what it printed: a crash at start, a signal.
  if (r.status !== 0 || r.signal) {
    const how = r.signal ? `was killed by ${r.signal}` : `exited ${r.status}`;
    throw new Error(`ee-builder at ${builderPath} ${how} when asked for its flags (-h):\n${usage.trim().slice(-2000)}`);
  }
  return [...IMAGE_FLAGS, MAX_WIDTH_FLAG].filter((f) => new RegExp(`^\\s+${f}\\b`, 'm').test(usage));
}

/**
 * The line of the site's ee.jsonc that turns image conversion on, or 0: an
 * "images" key whose value is "webp", "avif" or an object. Not a parser:
 * ee-builder reads the file properly. This only decides whether the builder
 * must be one that reads the key at all, since an older one ignores it and
 * packages the images unconverted.
 */
export function configImagesLine(src) {
  const r = readEEJsonc(join(src, 'ee.jsonc'));
  if (!r || r.value === null || typeof r.value !== 'object') return 0;
  const v = r.value.images;
  const format = typeof v === 'string' ? v : v && typeof v === 'object' ? v.format : undefined;
  if (format !== 'webp' && format !== 'avif') return 0;
  const m = /"images"\s*:/.exec(r.blanked);
  return m ? r.blanked.slice(0, m.index).split('\n').length : 1;
}

/**
 * ee.jsonc read as ee-builder reads it, near enough to know its "images"
 * setting: comments outside strings blanked (keeping every newline, so lines
 * still count) and trailing commas dropped, then JSON.parse. Null when the
 * file is missing or does not parse; ee-builder reports a broken file itself.
 */
export function readEEJsonc(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      const stop = nl < 0 ? text.length : nl;
      out += blank(text.slice(i, stop));
      i = stop - 1;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += blank(text.slice(i, stop));
      i = stop - 1;
    } else {
      out += c;
    }
  }
  // A comma with only blanks before the closing } or ], outside strings.
  let json = '';
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (c === '"') {
      let j = i + 1;
      while (j < out.length && out[j] !== '"') j += out[j] === '\\' ? 2 : 1;
      json += out.slice(i, j + 1);
      i = j;
    } else if (c === ',' && /^\s*[}\]]/.test(out.slice(i + 1))) {
      json += ' ';
    } else {
      json += c;
    }
  }
  try {
    return { value: JSON.parse(json), blanked: out };
  } catch {
    return null;
  }
}

/** Refuse a builder too old for the image options it is about to be given. */
export function requireImageSupport(builderPath, hint, why = '', needed = IMAGE_FLAGS) {
  const have = builderImageFlags(builderPath);
  const missing = needed.filter((f) => !have.includes(f));
  if (missing.length) {
    const what = missing.every((f) => f === MAX_WIDTH_FLAG) ? 'resize images' : 'convert images';
    throw new Error(
      `${why}ee-builder at ${builderPath} is too old to ${what}: it has no ` +
        `${missing.join(', ')} (\`ee-builder -h\` lists the flags it has). ${hint}`,
    );
  }
}

/**
 * Run ee-builder over a directory.
 *
 * Uses execFileSync, not execSync: the old code interpolated an unquoted path
 * into a shell string, so any space or metacharacter in the project path broke
 * the build at best.
 *
 * stdout is read for the summary below; stderr goes straight to the caller's
 * terminal, because that is where ee-builder writes its warnings and the
 * readable image report. stdin is closed: nothing should wait on it.
 */
export function runBuilder(builderPath, { src, out, level, domain = null, images = null }) {
  const stdout = execFileSync(builderPath, builderArgs({ src, out, level, domain, images }), {
    encoding: 'utf8',
    env: builderEnv(),
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const hash = stdout.match(/Content hash: ([a-f0-9]{64})/)?.[1];
  if (!hash) {
    throw new Error(
      `ee-builder produced no content hash for ${src}.\nOutput:\n${stdout}`,
    );
  }
  return {
    hash,
    secret: stdout.match(/Secret: ([a-f0-9]{64})/)?.[1] ?? null,
    salt: stdout.match(/Salt: ([a-f0-9]{64})/)?.[1] ?? null,
    fileCount: Number(stdout.match(/Files: (\d+)/)?.[1] ?? 0),
  };
}

/** Level 1/2 key material: base64url(secret || salt). */
export function toKey(secretHex, saltHex) {
  return Buffer.concat([
    Buffer.from(secretHex, 'hex'),
    Buffer.from(saltHex, 'hex'),
  ]).toString('base64url');
}

export function scratchFile(name) {
  return join(tmpdir(), `ee-${process.pid}-${name}`);
}
