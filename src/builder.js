/**
 * Acquiring and running the `ee-builder` binary.
 *
 * The previous integration required a Go binary sitting at a hardcoded relative
 * path (`../ee-builder/ee-builder`), which only worked for directories inside
 * the ee-cdn monorepo. Nothing outside that tree could use it. We download a
 * released binary from the control plane instead and cache it.
 */
import { execFileSync } from 'node:child_process';
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
import { dirname, join } from 'node:path';

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
 * Download (or reuse) the ee-builder binary.
 *
 * Integrity: the control plane publishes a `.sha256` sidecar for `edge-node`
 * but not for `ee-builder` (filed upstream). Until it does, we do
 * trust-on-first-use — the first download's digest is written to a lockfile in
 * the project and every later download must match it. Pass `checksum` to pin a
 * known digest explicitly and skip TOFU entirely.
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
  const expected = checksum ?? readLock(lockfilePath, key, version);

  if (existsSync(binPath)) {
    const have = sha256(readFileSync(binPath));
    if (!expected || have === expected) return binPath;
    logger.warn(`Cached ee-builder digest ${have} did not match; re-downloading.`);
  }

  const url = `${controlPlane}/releases/ee-builder/${version}/${os}/${arch}`;
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

/**
 * Run ee-builder over a directory.
 *
 * Uses execFileSync, not execSync: the old code interpolated an unquoted path
 * into a shell string, so any space or metacharacter in the project path broke
 * the build at best.
 */
export function runBuilder(builderPath, { src, out, level }) {
  const stdout = execFileSync(
    builderPath,
    ['-src', src, '-out', out, '-level', String(level)],
    { encoding: 'utf8' },
  );

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
