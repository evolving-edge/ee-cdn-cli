/**
 * Tests for the domain-claim client (#432). fetch is replaced with a fake
 * control plane that holds one claim and moves it along as the real
 * reconciler would.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  createClaim,
  describeClaim,
  formatRecords,
  getClaim,
  verifyNow,
  waitForActive,
} from '../src/domains.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const CP = 'https://cp.example/';
const records = {
  txtName: '_ee-verify.blog.example.com',
  txtValue: 'ee-verify=abc',
  cnameName: 'blog.example.com',
  cnameTarget: 'cdn.3dge.app',
};

/** A control plane whose claim goes through the given states, one per verify. */
function fakeControlPlane(states, { verifyStatus = 200 } = {}) {
  const calls = [];
  let i = 0;
  const claim = () => ({ domain: 'blog.example.com', state: states[Math.min(i, states.length - 1)] });
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, auth: init.headers?.Authorization, body: init.body });
    const path = new URL(url).pathname;
    if (method === 'POST' && path === '/api/domain-claims') {
      return new Response(JSON.stringify({ claim: claim(), records }), { status: 201 });
    }
    if (method === 'POST' && path.endsWith('/verify')) {
      i++;
      const c = claim();
      return new Response(JSON.stringify({ claim: c, ...(c.state === 'pending_verification' ? { records } : {}) }), { status: verifyStatus });
    }
    if (method === 'GET') {
      // Past pending, the reconciler moves the claim on between reads.
      const c = claim();
      if (c.state !== 'pending_verification') i++;
      return new Response(JSON.stringify({ claim: c }), { status: 200 });
    }
    return new Response('{"error":"unexpected"}', { status: 500 });
  };
  return calls;
}

describe('domain claims (#432)', () => {
  it('creates a pending claim with the token, and returns the records to add', async () => {
    const calls = fakeControlPlane(['pending_verification']);
    const view = await createClaim({ controlPlane: CP, token: 't0k', domain: 'blog.example.com', projectId: 'proj_1' });
    assert.equal(view.claim.state, 'pending_verification');
    assert.deepEqual(view.records, records);
    assert.equal(calls[0].url, 'https://cp.example/api/domain-claims');
    assert.equal(calls[0].auth, 'Bearer t0k');
    assert.deepEqual(JSON.parse(calls[0].body), { domain: 'blog.example.com', projectId: 'proj_1' });
  });

  it('prints the records so they can be copied', () => {
    const out = formatRecords(records);
    assert.match(out, /TXT\s+_ee-verify\.blog\.example\.com/);
    assert.match(out, /"ee-verify=abc"/);
    assert.match(out, /CNAME\s+blog\.example\.com\n\s+cdn\.3dge\.app/);
  });

  it('waits through verification and the certificate until active', async () => {
    fakeControlPlane(['pending_verification', 'pending_verification', 'cert_pending', 'active']);
    const seen = [];
    let slept = 0;
    const claim = await waitForActive({
      controlPlane: CP,
      token: 't',
      domain: 'blog.example.com',
      onTick: (line) => seen.push(line),
      sleep: async () => {
        slept++;
      },
    });
    assert.equal(claim.state, 'active');
    assert.ok(seen.some((l) => l.includes('pending_verification')));
    assert.ok(seen.at(-1).includes('active'));
    assert.ok(slept >= 1);
  });

  it('stops with the reason when the claim fails', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ claim: { domain: 'x.example', state: 'failed', failureReason: 'no TXT record within 72h' } }), { status: 200 });
    await assert.rejects(
      waitForActive({ controlPlane: CP, token: 't', domain: 'x.example', sleep: async () => {} }),
      /failed: no TXT record within 72h/,
    );
  });

  it('gives up at the timeout rather than polling forever', async () => {
    fakeControlPlane(['pending_verification']);
    let t = 0;
    await assert.rejects(
      waitForActive({
        controlPlane: CP,
        token: 't',
        domain: 'blog.example.com',
        intervalMs: 60_000,
        timeoutMs: 180_000,
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      }),
      /still pending_verification after 3 minutes/,
    );
  });

  it('reports a failed DNS lookup as that, not as a missing record', async () => {
    fakeControlPlane(['pending_verification'], { verifyStatus: 502 });
    const view = await verifyNow({ controlPlane: CP, token: 't', domain: 'blog.example.com' });
    assert.equal(view.lookupFailed, true);
  });

  it('explains the refusals it knows about', async () => {
    for (const [status, pattern] of [
      [401, /token was rejected/],
      [409, /already claimed/],
      [429, /too many claims waiting on DNS/],
      [503, /not configured/],
    ]) {
      globalThis.fetch = async () => new Response('{"error":"nope"}', { status });
      await assert.rejects(
        createClaim({ controlPlane: CP, token: 't', domain: 'a.example', projectId: 'p' }),
        pattern,
        `status ${status}`,
      );
    }
    globalThis.fetch = async () => new Response('{"error":"no claim for this domain"}', { status: 404 });
    await assert.rejects(getClaim({ controlPlane: CP, token: 't', domain: 'a.example' }), /404 no claim for this domain/);
  });

  it('describes a claim in one line', () => {
    assert.equal(
      describeClaim({ domain: 'a.example', state: 'active', dnsWarning: 'TXT gone', lastCheckedAt: '2026-09-30T00:00:00Z' }),
      'a.example: active (warning: TXT gone) last checked 2026-09-30T00:00:00Z',
    );
  });
});
