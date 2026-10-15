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

  if (existsSync(binPath)) {
    const have = sha256(readFileSync(binPath));
    if (expected && have === expected) {
      if (published && published !== expected) {
        logger.warn(
          `A newer ee-builder ${version} is published (sha256 ${published.slice(0, 16)}…), ` +
            `but ${lockfilePath} pins ${expected.slice(0, 16)}…. Delete its ` +
            `"${version}:${key}" entry to move to the newer one.`,
        );
      }
      return binPath;
    }
    if (!expected && (!published || have === published)) return binPath;
    if (expected) {
      logger.warn(`Cached ee-builder digest ${have} did not match; re-downloading.`);
    } else {
      logger.info(`A newer ee-builder ${version} is published; replacing the cached copy.`);
    }
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

  mkdirSync(cacheDir, { recursive: true });
  // Write via a temp name so a killed build cannot leave a truncated binary.
  const tmp = join(cacheDir, `.ee-builder-${process.pid}.part`);
  writeFileSync(tmp, bytes);
  chmodSync(tmp, 0o755);
  renameSync(tmp, binPath);

  if (!checksum) {
    writeLock(lockfilePath, key, version, digest, Boolean(expected), logger);
  }
  logger.info(`ee-builder ready (${(bytes.length / 1e6).toFixed(1)} MB, sha256 ${digest.slice(0, 16)}…)`);
  return binPath;
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

/** Image formats ee-builder converts to, and "off" to override ee.jsonc. */
export const IMAGE_FORMATS = new Set(['webp', 'avif', 'off']);

/** The image flags builderArgs passes. ee-builder gained all three at once. */
export const IMAGE_FLAGS = ['-images', '-image-hosts', '-image-report'];

/**
 * Check and normalise the image options, or return null when none was given,
 * in which case nothing image-related is passed and ee.jsonc alone decides.
 * The report path is made absolute so it does not depend on where ee-builder
 * runs.
 */
export function imageOptions({ images = null, imageHosts = [], imageReport = null } = {}) {
  const hosts = (imageHosts ?? []).map((h) => String(h).trim()).filter(Boolean);
  if (images == null && hosts.length === 0 && !imageReport) return null;
  if (images != null && !IMAGE_FORMATS.has(images)) {
    throw new Error(`images must be webp, avif or off (got "${images}")`);
  }
  for (const h of hosts) {
    // Joined with commas for -image-hosts, so one host cannot hold one.
    if (/[\s,/]/.test(h)) {
      throw new Error(`image host "${h}" is not a host name; give the host alone, as in www.example.com`);
    }
  }
  return {
    format: images ?? null,
    hosts,
    report: imageReport ? (isAbsolute(imageReport) ? imageReport : resolve(process.cwd(), imageReport)) : null,
  };
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
  }
  return args;
}

/**
 * The image flags a builder lists in its usage, which every ee-builder prints
 * for -h. The flags are asked about directly, not the version: the builder
 * published from 19a3771 already reports image pipeline 1 on -version (the
 * encoders came first, in #638) but has none of these flags, which came with
 * #644.
 */
export function builderImageFlags(builderPath) {
  const r = spawnSync(builderPath, ['-h'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
  });
  const usage = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return IMAGE_FLAGS.filter((f) => new RegExp(`^\\s+${f}\\b`, 'm').test(usage));
}

/** Refuse a builder too old for the image options it is about to be given. */
export function requireImageSupport(builderPath, hint) {
  const have = builderImageFlags(builderPath);
  const missing = IMAGE_FLAGS.filter((f) => !have.includes(f));
  if (missing.length) {
    throw new Error(
      `ee-builder at ${builderPath} is too old to convert images: it has no ` +
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
