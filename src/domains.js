/**
 * Custom-domain claims on the control plane (#432).
 *
 * A hostname is served for a project only once the project holds an active
 * claim on it. A claim starts pending: the owner adds a TXT record proving
 * control of the name and a CNAME pointing it at the CDN, the control plane's
 * reconciler sees the TXT record, a certificate is issued, and the claim goes
 * active. These calls create a claim, read it, and ask for an immediate check.
 *
 * A project-scoped deploy token manages its own project's claims (self-serve,
 * #432); an admin token manages any. Global deploy tokens are refused.
 */

const TERMINAL_OK = 'active';
const TERMINAL_BAD = new Set(['failed', 'removed']);

function base(controlPlane) {
  return controlPlane.replace(/\/$/, '');
}

async function call({ controlPlane, token, method, path, body }) {
  const res = await fetch(`${base(controlPlane)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: text.trim() };
  }
  return { status: res.status, json };
}

/** A failed call as an Error that says what to do about it. */
function failure(action, status, json) {
  const message = json.error || `HTTP ${status}`;
  return new Error(`${action} failed: ${status} ${message}${hint(status)}`);
}

function hint(status) {
  switch (status) {
    case 401:
      return '\nThe token was rejected. Pass --token or set EE_CDN_TOKEN.';
    case 403:
      return '\nThe token is valid but may not manage this claim. Use a project-scoped deploy token for the claim\'s project, or an admin token; global deploy tokens are refused.';
    case 409:
      return '\nThe hostname is already claimed, by this project or another.';
    case 429:
      return '\nThe project has too many claims waiting on DNS. Finish or remove one first.';
    case 503:
      return '\nDomain claims are not configured on this control plane.';
    default:
      return '';
  }
}

/** Create a pending claim. Resolves to { claim, records }. */
export async function createClaim({ controlPlane, token, domain, projectId, orgId }) {
  const { status, json } = await call({
    controlPlane,
    token,
    method: 'POST',
    path: '/api/domain-claims',
    body: { domain, projectId, ...(orgId ? { orgId } : {}) },
  });
  if (status !== 201) throw failure('Creating the claim', status, json);
  return json;
}

/** Read a claim. Resolves to { claim, records? }. */
export async function getClaim({ controlPlane, token, domain }) {
  const { status, json } = await call({
    controlPlane,
    token,
    method: 'GET',
    path: `/api/domain-claims/${encodeURIComponent(domain)}`,
  });
  if (status !== 200) throw failure('Reading the claim', status, json);
  return json;
}

/**
 * Ask the control plane to look for the TXT record now. Resolves to
 * { claim, records?, lookupFailed }. A claim that is past pending is not an
 * error here; it is returned as it stands.
 */
export async function verifyNow({ controlPlane, token, domain }) {
  const { status, json } = await call({
    controlPlane,
    token,
    method: 'POST',
    path: `/api/domain-claims/${encodeURIComponent(domain)}/verify`,
  });
  if (status === 200 || status === 409) return { ...json, lookupFailed: false };
  // 502: the lookup itself failed, so "still pending" says nothing about DNS.
  if (status === 502) return { ...json, lookupFailed: true };
  throw failure('Verifying the claim', status, json);
}

/** The records to add, as lines a person can copy. */
export function formatRecords(records) {
  if (!records) return '';
  return [
    `  TXT    ${records.txtName}`,
    `         "${records.txtValue}"`,
    `  CNAME  ${records.cnameName}`,
    `         ${records.cnameTarget}`,
  ].join('\n');
}

/** One line describing where a claim stands. */
export function describeClaim(claim) {
  const parts = [`${claim.domain}: ${claim.state}`];
  if (claim.failureReason) parts.push(`(${claim.failureReason})`);
  if (claim.dnsWarning) parts.push(`(warning: ${claim.dnsWarning})`);
  if (claim.lastCheckedAt) parts.push(`last checked ${claim.lastCheckedAt}`);
  return parts.join(' ');
}

/**
 * Poll until the claim is active or can't get there. While it is pending it
 * asks for an immediate check each time; after that it reads the claim, since
 * the certificate step is the reconciler's. Resolves to the final claim;
 * rejects if the claim failed, was removed, or the time ran out.
 */
export async function waitForActive({
  controlPlane,
  token,
  domain,
  intervalMs = 30_000,
  timeoutMs = 2 * 60 * 60 * 1000,
  onTick = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
}) {
  const deadline = now() + timeoutMs;
  let last = '';
  for (;;) {
    const view = await getClaim({ controlPlane, token, domain });
    let claim = view.claim;
    let lookupFailed = false;
    if (claim.state === 'pending_verification') {
      const checked = await verifyNow({ controlPlane, token, domain });
      claim = checked.claim ?? claim;
      lookupFailed = checked.lookupFailed;
    }
    const line = describeClaim(claim) + (lookupFailed ? ' (DNS lookup failed; will retry)' : '');
    if (line !== last) {
      onTick(line, claim);
      last = line;
    }
    if (claim.state === TERMINAL_OK) return claim;
    if (TERMINAL_BAD.has(claim.state)) {
      throw new Error(`${domain} is ${claim.state}${claim.failureReason ? `: ${claim.failureReason}` : ''}`);
    }
    if (now() >= deadline) {
      throw new Error(`${domain} is still ${claim.state} after ${Math.round(timeoutMs / 60000)} minutes`);
    }
    await sleep(intervalMs);
  }
}
