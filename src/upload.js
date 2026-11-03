/**
 * Control-plane client.
 *
 * Targets the same endpoint the portal's own documentation gives customers:
 *   PUT /api/workloads/store-raw?hash=…  with the .ee bytes as the body.
 *
 * The previous integration hand-rolled a multipart POST to
 * /api/workloads/upload and then PUT /api/domains/{domain} — a route the
 * control plane registers behind a *read* permission. Both have been replaced
 * with the single documented call, which also creates the deploy alias and the
 * mutable "latest" alias server-side.
 */
import { createDecipheriv, hkdfSync } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';

/** Query params handleWorkloadStoreRaw understands. */
const PASSTHROUGH = [
  'domain',
  'orgId',
  'projectId',
  'projectName',
  'projectSlug',
  'buildName',
  'buildId',
  'name',
  'encryptionLevel',
  'fileCount',
];

/**
 * The control plane refuses packages over 100 MiB (its configured limit,
 * checked against Content-Length before it reads the body, #819). Mirrored here
 * so an oversized workload fails locally with a clear message.
 */
const MAX_BYTES = 100 * 1024 * 1024;
const MIB = 1024 * 1024;

export async function storeWorkload({
  filePath,
  hash,
  controlPlane,
  token,
  params = {},
  secret = null,
  logger,
}) {
  const { size } = statSync(filePath);
  if (size > MAX_BYTES) {
    throw new Error(
      `Workload is ${(size / MIB).toFixed(1)} MiB; the control plane rejects ` +
        `bodies over ${MAX_BYTES / MIB} MiB.`,
    );
  }

  const query = new URLSearchParams({ hash });
  for (const key of PASSTHROUGH) {
    const value = params[key];
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, String(value));
    }
  }

  const url = `${controlPlane.replace(/\/$/, '')}/api/workloads/store-raw?${query}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size),
      ...secretHeader(secret),
    },
    // Streamed from disk, never read whole (#819), with its exact length so
    // the control plane can refuse an oversized package before reading it.
    // Node's fetch needs duplex: 'half' for a streamed body.
    body: uploadBody(filePath, size),
    duplex: 'half',
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Upload failed: ${res.status} ${res.statusText}\n${text}\n` +
        explain(res.status),
    );
  }

  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    // The endpoint has returned bare text in the past; the upload still stood.
  }
  logger.info(
    `Uploaded ${(size / 1e6).toFixed(2)} MB — ${hash.slice(0, 16)}…` +
      (body.alias ? ` (alias ${body.alias})` : ''),
  );
  return body;
}

/**
 * The package as a stream of exactly `size` bytes, the size the request's
 * Content-Length announced (a file that grew since would otherwise send more).
 */
export function uploadBody(filePath, size) {
  if (size === 0) return new Uint8Array(0);
  return Readable.toWeb(createReadStream(filePath, { start: 0, end: size - 1 }));
}

/**
 * The Level 2 workload secret, as a header.
 *
 * Without it the control plane stores the ciphertext and nothing else: it
 * registers a gateway secret only when this header (or the legacy `secret`
 * query parameter) is present, so `/api/access-token` has nothing to hand out
 * and every edge request for the workload fails with "decryption key
 * unavailable". The upload reports success either way, which is what made this
 * hard to see -- the deploy is green and the site is broken.
 *
 * A header rather than the query parameter, deliberately. A query string is the
 * part of a request that proxies, access logs and traces record by default, so
 * the URL form can publish a long-lived key before the control plane has even
 * stored it. The query form still works server-side for older CLI builds; new
 * callers do not use it.
 *
 * Only the secret travels. The control plane takes the matching salt from the
 * .ee header's own kdfSalt, so sending the derived key would be both wrong and
 * more material than it needs.
 *
 * Callers must pass this for Level 2 *only*. A Level 1 key must never reach a
 * server -- that is the entire distinction between the two levels, and sending
 * it here would be the same defect as #208.
 */
function secretHeader(secret) {
  return secret ? { 'X-EE-Workload-Secret': secret } : {};
}

/**
 * Deploying content the control plane already holds (#560).
 *
 * A Level 1 or Level 2 package gets a fresh random secret and salt on every
 * build, so packaging unchanged content again gives the same content hash and
 * different bytes, and the control plane refuses that upload with 409: a hash
 * keeps its first bytes. A rollback re-uploads an earlier hash and meets the
 * same check. So before uploading, ask whether the hash is stored, and when it
 * is stored at the level asked for and this project owns it, deploy the stored
 * workload instead (POST /api/workloads/<hash>/deploy, no body). The new
 * package, and the key it was built with, are thrown away.
 */

/**
 * GET /api/workloads/<hash>/status. Null when the control plane will not say,
 * so the caller uploads as it always has: one that predates the route answers
 * 404, or 403 to a deploy token, since the request falls through to a
 * metadata read that needs read:workloads, which a deploy token lacks. The
 * upload is authorised on its own.
 */
export async function workloadStatus({ hash, controlPlane, token, projectId }) {
  const query = new URLSearchParams();
  if (projectId) query.set('projectId', projectId);
  const qs = query.toString();
  const url =
    `${controlPlane.replace(/\/$/, '')}/api/workloads/${hash}/status` + (qs ? `?${qs}` : '');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) {
    throw new Error(
      `Could not ask the control plane whether ${hash.slice(0, 16)}… is stored: ` +
        `${res.status} ${res.statusText}\n${text}\n` + explain(res.status),
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Whether a Level 1 key (base64url of the 32-byte secret and the 32-byte salt,
 * the value after #key=) opens the stored workload: it decrypts the stored
 * index, which is the first thing a browser holding it does. Same derivation
 * as the builder and the browser: HKDF-SHA256 over secret || contentHash.
 */
export function level1KeyOpens(key, status) {
  let raw;
  try {
    raw = Buffer.from(String(key).replace(/=+$/, ''), 'base64url');
  } catch {
    return false;
  }
  if (raw.length !== 64 || !status?.index || !/^[0-9a-f]{64}$/.test(status.kdfContentHash ?? '')) {
    return false;
  }
  try {
    const ikm = Buffer.concat([raw.subarray(0, 32), Buffer.from(status.kdfContentHash, 'hex')]);
    const master = Buffer.from(hkdfSync('sha256', ikm, raw.subarray(32), 'ee-master-key', 32));
    const indexKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'ee-index-key', 32));
    const decipher = createDecipheriv('aes-256-gcm', indexKey, Buffer.from(status.indexNonce, 'hex'));
    decipher.setAuthTag(Buffer.from(status.indexAuthTag, 'hex'));
    decipher.update(Buffer.from(status.index, 'base64'));
    decipher.final();
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide between uploading and deploying what is stored.
 *
 * Returns { useStored: false } to upload, or { useStored: true, key } to deploy
 * the stored workload, where key is the Level 1 key that opens it. Throws when
 * neither can succeed. keys are the Level 1 keys the caller holds for this
 * content (its cache, or one given by hand), tried in order.
 */
export function decideStored(status, level, keys = []) {
  if (!status?.stored) return { useStored: false };
  // Not this project's to deploy without its bytes: the upload decides
  // (identical bytes of a workload nobody owns are accepted, another
  // project's workload is refused, other bytes are refused).
  if (!status.owned) return { useStored: false };
  if (status.level !== level) {
    throw new Error(
      `This content is already stored at Level ${status.level}, and this deploy is Level ${level}. ` +
        `Deploy it at Level ${status.level}, or change the content.`,
    );
  }
  if (level === 2) {
    // With no secret held the gateways cannot decrypt it. Uploading identical
    // bytes with their secret registers one; other bytes are refused.
    return { useStored: Boolean(status.secretHeld) };
  }
  if (level === 1) {
    const key = keys.filter(Boolean).find((k) => level1KeyOpens(k, status));
    if (!key) {
      throw new Error(
        'This content is already stored at Level 1, under the key from its first deploy. ' +
          'A new package cannot be uploaded over it, and its new key would open nothing. ' +
          'Pass that key with --key (the value after #key= in the site\'s links); ' +
          (keys.filter(Boolean).length ? 'the key given does not open the stored content.' : 'no key was given or cached.'),
      );
    }
    return { useStored: true, key };
  }
  return { useStored: true };
}

/** POST /api/workloads/<hash>/deploy: the same query as store-raw, no body. */
export async function deployStoredWorkload({ hash, controlPlane, token, params = {}, logger }) {
  const query = new URLSearchParams();
  for (const key of PASSTHROUGH) {
    const value = params[key];
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, String(value));
    }
  }
  const url = `${controlPlane.replace(/\/$/, '')}/api/workloads/${hash}/deploy?${query}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Deploy of the stored workload failed: ${res.status} ${res.statusText}\n${text}\n` +
        explain(res.status),
    );
  }
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    // Accepted; nothing more to report.
  }
  logger.info(
    `Already stored at Level ${String(params.encryptionLevel ?? '').replace('level', '')}: nothing uploaded — ` +
      `${hash.slice(0, 16)}…` + (body.alias ? ` (alias ${body.alias})` : ''),
  );
  return body;
}

/**
 * Publish a packaged workload: deploy the stored one when decideStored says
 * so, else upload the package. Returns { uploaded, key }, key being the
 * stored workload's Level 1 key on a deploy without upload.
 */
export async function publishWorkload({
  filePath,
  hash,
  level,
  controlPlane,
  token,
  params = {},
  secret = null,
  keys = [],
  beforeUpload = null,
  logger,
}) {
  const status = await workloadStatus({ hash, controlPlane, token, projectId: params.projectId });
  const decision = decideStored(status, level, keys);
  if (decision.useStored) {
    await deployStoredWorkload({ hash, controlPlane, token, params, logger });
    return { uploaded: false, key: decision.key ?? null };
  }
  // Runs once the upload is chosen and before any bytes are sent, so a
  // caller can keep this package's key even if the upload's response is lost.
  if (beforeUpload) beforeUpload();
  await storeWorkload({ filePath, hash, controlPlane, token, params, secret, logger });
  return { uploaded: true, key: null };
}

/** Turn the failure modes we know about into something actionable. */
function explain(status) {
  switch (status) {
    case 401:
      return (
        'The token was rejected. Check EE_CDN_TOKEN is a current deploy token ' +
        'from the portal (Workload → Deploy Tokens).'
      );
    // The control plane sends a different 403 body for each cause, and the
    // body is printed above this hint. "Insufficient permissions" comes from
    // the auth middleware, before the token's project is ever looked at.
    case 403:
      return (
        'If the error is "Insufficient permissions", the token is valid but ' +
        'lacks the workload:write role — check its roles in the portal ' +
        '(Workload → Deploy Tokens). Otherwise the token is revoked, unknown, ' +
        'or scoped to a different project; if it is project-scoped, ' +
        'deploy.projectId must match it exactly.'
      );
    case 500:
      return (
        'The control plane verifies deploy tokens through Redis. If its ' +
        '/health reports redis_connected:false, this is an outage on their ' +
        'side, not a problem with your build.'
      );
    default:
      return '';
  }
}
