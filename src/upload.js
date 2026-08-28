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

/** The control plane caps request bodies at 100 MB. */
const MAX_BYTES = 100 * 1024 * 1024;

export async function storeWorkload({
  filePath,
  hash,
  controlPlane,
  token,
  params = {},
  logger,
}) {
  const { size } = statSync(filePath);
  if (size > MAX_BYTES) {
    throw new Error(
      `Workload is ${(size / 1e6).toFixed(1)} MB; the control plane rejects ` +
        `bodies over ${MAX_BYTES / 1e6} MB.`,
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

/** Turn the failure modes we know about into something actionable. */
function explain(status) {
  switch (status) {
    case 401:
      return (
        'The token was rejected. Check EE_CDN_TOKEN is a current deploy token ' +
        'from the portal (Workload → Deploy Tokens).'
      );
    case 403:
      return (
        'The token is revoked, unknown, or scoped to a different project. ' +
        'If it is project-scoped, deploy.projectId must match it exactly.'
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
