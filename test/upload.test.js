/**
 * Tests for the control-plane client.
 *
 * This is the file that talks to production, and it was the blast radius for
 * every failure we hit taking the first site live: a rejected token, a
 * project-scope mismatch, and a Redis outage that surfaced as a 500. The point
 * of these tests is that each of those still produces a message that tells the
 * operator what to do, and that we never send a request the control plane will
 * reject on shape alone.
 *
 * fetch is stubbed rather than mocked through a seam — storeWorkload calls the
 * global directly, so the global is what we replace.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, truncateSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';

import { storeWorkload } from '../src/upload.js';

const scratch = mkdtempSync(join(tmpdir(), 'ee-upload-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Records the request and replies with whatever the test asks for. */
function stubFetch({ status = 200, statusText = 'OK', body = '{}' } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      text: async () => body,
    };
  };
  return calls;
}

const quietLogger = { info() {}, warn() {} };

function workload(name, bytes = 'ee-workload-bytes') {
  const p = join(scratch, name);
  writeFileSync(p, bytes);
  return p;
}

const HASH = 'a'.repeat(64);

function call(overrides = {}) {
  return storeWorkload({
    filePath: workload('w.ee'),
    hash: HASH,
    controlPlane: 'https://cp.example.test',
    token: 'tok_123',
    logger: quietLogger,
    ...overrides,
  });
}

describe('storeWorkload request shape', () => {
  it('PUTs the bytes with a bearer token', async () => {
    const calls = stubFetch();
    await call();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.method, 'PUT');
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok_123');
    assert.equal(
      calls[0].opts.headers['Content-Type'],
      'application/octet-stream',
    );
    assert.equal(calls[0].opts.body.toString(), 'ee-workload-bytes');
  });

  it('always sends the hash', async () => {
    const calls = stubFetch();
    await call();
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, '/api/workloads/store-raw');
    assert.equal(url.searchParams.get('hash'), HASH);
  });

  it('passes through the params the endpoint understands', async () => {
    const calls = stubFetch();
    await call({
      params: {
        domain: 'blog.example.test',
        projectId: 'proj_abc',
        encryptionLevel: 'level0',
        fileCount: 12,
      },
    });
    const q = new URL(calls[0].url).searchParams;
    assert.equal(q.get('domain'), 'blog.example.test');
    assert.equal(q.get('projectId'), 'proj_abc');
    assert.equal(q.get('encryptionLevel'), 'level0');
    // Numbers are stringified, not dropped.
    assert.equal(q.get('fileCount'), '12');
  });

  it('omits empty params rather than sending blanks', async () => {
    const calls = stubFetch();
    await call({
      params: { domain: '', projectId: null, buildId: undefined, name: 'site' },
    });
    const q = new URL(calls[0].url).searchParams;
    assert.equal(q.has('domain'), false);
    assert.equal(q.has('projectId'), false);
    assert.equal(q.has('buildId'), false);
    assert.equal(q.get('name'), 'site');
  });

  it('drops params the endpoint does not understand', async () => {
    const calls = stubFetch();
    await call({ params: { nonsense: 'x', domain: 'ok.test' } });
    const q = new URL(calls[0].url).searchParams;
    assert.equal(q.has('nonsense'), false);
    assert.equal(q.get('domain'), 'ok.test');
  });

  it('does not double the slash on a trailing-slash control plane', async () => {
    const calls = stubFetch();
    await call({ controlPlane: 'https://cp.example.test/' });
    assert.ok(
      calls[0].url.startsWith('https://cp.example.test/api/workloads/store-raw?'),
      calls[0].url,
    );
  });
});

describe('storeWorkload size cap', () => {
  it('refuses a body over 100 MB before making a request', async () => {
    const big = join(scratch, 'big.ee');
    writeFileSync(big, '');
    truncateSync(big, 101 * 1024 * 1024); // sparse — costs no disk
    const calls = stubFetch();
    await assert.rejects(
      () => call({ filePath: big }),
      /Workload is 101\.0 MiB; .* over 100 MiB/,
    );
    // The point of the cap is to fail locally, not to be told by the server.
    assert.equal(calls.length, 0);
  });
});

describe('storeWorkload failure messages', () => {
  const cases = [
    [401, /current deploy token/],
    [403, /scoped to a different project/],
    [500, /redis_connected:false/],
  ];

  for (const [status, expected] of cases) {
    it(`explains a ${status}`, async () => {
      stubFetch({ status, statusText: 'Err', body: 'server said no' });
      await assert.rejects(() => call(), (err) => {
        assert.match(err.message, new RegExp(`Upload failed: ${status}`));
        assert.match(err.message, /server said no/); // server text is preserved
        assert.match(err.message, expected);
        return true;
      });
    });
  }

  it('still reports an unrecognised status without inventing advice', async () => {
    stubFetch({ status: 418, statusText: 'Teapot', body: 'nope' });
    await assert.rejects(() => call(), (err) => {
      assert.match(err.message, /Upload failed: 418 Teapot/);
      assert.match(err.message, /nope/);
      return true;
    });
  });
});

describe('storeWorkload success handling', () => {
  it('returns the parsed body', async () => {
    stubFetch({ body: JSON.stringify({ alias: 'maple-wand', hash: HASH }) });
    const body = await call();
    assert.equal(body.alias, 'maple-wand');
  });

  it('tolerates a non-JSON 200 — the upload still stood', async () => {
    stubFetch({ body: 'stored' });
    const body = await call();
    assert.deepEqual(body, {});
  });

  it('names the alias in the log when the server returns one', async () => {
    stubFetch({ body: JSON.stringify({ alias: 'good-tank' }) });
    const lines = [];
    await call({ logger: { info: (m) => lines.push(m), warn() {} } });
    assert.match(lines.join('\n'), /alias good-tank/);
  });
});
