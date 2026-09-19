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
import { readFileSync, statSync } from 'node:fs';

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
 * The control plane caps request bodies at 100 MiB — handleWorkloadStoreRaw
 * wraps the body in `http.MaxBytesReader(w, r.Body, 100<<20)`. Mirrored here so
 * an oversized workload fails locally with a clear message rather than as a
 * truncated read on their side.
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
      ...secretHeader(secret),
    },
    body: readFileSync(filePath),
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
