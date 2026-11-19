/**
 * Block-aware uploads (#920): a Level 0 redeploy to a domain sends only the
 * blocks the domain's current package lacks, and anything that goes wrong
 * ends in the whole upload that happened before.
 *
 * The stub control plane puts the package back together the way
 * control-plane/workload_reuse.go does, so the test checks the bytes that
 * would be stored and not the shape of the request.
 */
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reuseUploadParts, storeWorkload } from '../src/upload.js';

const scratch = mkdtempSync(join(tmpdir(), 'ee-reuse-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const HASH = 'b'.repeat(64);
const BASE = 'c'.repeat(64);

/** A package of a 600-byte head and the given blocks, with its record. */
function pkg(blocks) {
  const head = randomBytes(600);
  const digest = { version: 1, containerSize: 0, blocks: [] };
  let offset = head.length;
  for (const b of blocks) {
    digest.blocks.push({ offset, size: b.length, digest: createHash('sha256').update(b).digest('hex') });
    offset += b.length;
  }
  digest.containerSize = offset;
  return { bytes: Buffer.concat([head, ...blocks]), digest };
}

const shared = [randomBytes(300_000), randomBytes(150_000), randomBytes(90_000)];
const v1 = pkg([randomBytes(2_000), ...shared]);
const v2 = pkg([randomBytes(5_000), shared[1], shared[0], randomBytes(40_000), shared[2], randomBytes(700)]);

function onDisk(name, p, { record = true } = {}) {
  const path = join(scratch, name);
  writeFileSync(path, p.bytes);
  if (record) writeFileSync(`${path}.digest.json`, JSON.stringify(p.digest));
  return path;
}

/** A control plane holding v1 as the domain's package. */
function stubControlPlane({ plan = 200, reuse = 200, planBody = null } = {}) {
  const seen = { puts: [], stored: null, sent: [] };
  const held = new Map(v1.digest.blocks.map((b) => [b.digest, b]));
  globalThis.fetch = async (url, opts) => {
    const u = new URL(String(url));
    const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, statusText: '', text: async () => body });
    if (u.pathname === '/api/limits') return reply(404, '');
    if (u.pathname === '/api/workloads/reuse-plan') {
      if (plan !== 200) return reply(plan, 'no');
      if (planBody) return reply(200, JSON.stringify(planBody));
      const rec = JSON.parse(opts.body);
      const have = rec.blocks.flatMap((b, i) => (held.has(b.digest) ? [i] : []));
      return reply(200, JSON.stringify({ base: have.length ? BASE : '', have }));
    }
    const body = Buffer.from(await new Response(opts.body, { duplex: 'half' }).arrayBuffer());
    seen.sent.push(Number(opts.headers['Content-Length']));
    assert.equal(body.length, Number(opts.headers['Content-Length']), 'Content-Length is the body');
    if (!u.searchParams.get('reuseFrom')) {
      seen.puts.push('whole');
      seen.stored = body;
      return reply(200, '{"stored":true}');
    }
    seen.puts.push('reuse');
    if (reuse !== 200) return reply(reuse, '{"reuse":"upload-whole"}');
    assert.equal(u.searchParams.get('reuseFrom'), BASE);
    const n = body.readUInt32BE(0);
    const m = JSON.parse(body.subarray(4, 4 + n));
    assert.equal(u.searchParams.get('packageSize'), String(m.digest.containerSize));
    let at = 4 + n;
    const take = (len) => body.subarray(at, (at += len));
    const out = [take(m.digest.blocks[0].offset)];
    const skip = new Set(m.have);
    m.digest.blocks.forEach((b, i) => {
      const from = held.get(b.digest);
      out.push(skip.has(i) ? v1.bytes.subarray(from.offset, from.offset + from.size) : take(b.size));
    });
    assert.equal(at, body.length, 'nothing follows the last block');
    seen.stored = Buffer.concat(out);
    return reply(200, '{"stored":true,"alias":"able-ace"}');
  };
  return seen;
}

const lines = [];
const logger = { info: (m) => lines.push(m), warn() {} };

function deploy(filePath, params = {}) {
  return storeWorkload({
    filePath,
    hash: HASH,
    controlPlane: 'https://cp.example.test',
    token: 'tok',
    params: { domain: 'site', encryptionLevel: 'level0', projectId: 'p1', ...params },
    logger,
  });
}

describe('block-aware upload', () => {
  it('sends only the blocks the domain\'s package lacks, and the package is put together whole', async () => {
    const seen = stubControlPlane();
    const body = await deploy(onDisk('v2.ee', v2));
    assert.deepEqual(seen.puts, ['reuse']);
    assert.ok(seen.stored.equals(v2.bytes), 'what the control plane put together is the package');
    assert.ok(seen.sent[0] < v2.bytes.length / 5, `sent ${seen.sent[0]} of ${v2.bytes.length} bytes`);
    assert.equal(body.alias, 'able-ace');
    assert.match(lines.at(-1), /already in the domain's current package/);
  });

  it('joins neighbouring ranges and covers every byte not reused, once', () => {
    const { prefix, ranges, size } = reuseUploadParts(v2.digest, [1, 2, 4]);
    const b = v2.digest.blocks;
    assert.deepEqual(ranges, [[0, b[1].offset], [b[3].offset, b[4].offset], [b[5].offset, v2.digest.containerSize]]);
    assert.equal(size, prefix.length + ranges.reduce((n, [a, z]) => n + z - a, 0));
    assert.equal(prefix.readUInt32BE(0), prefix.length - 4);
  });

  const whole = {
    'no domain': [{}, { domain: '' }, ['whole']],
    'not Level 0': [{}, { encryptionLevel: 'level2' }, ['whole']],
    'a control plane without the route': [{ plan: 404 }, {}, ['whole']],
    'nothing to reuse': [{ planBody: { base: '', have: [] } }, {}, ['whole']],
    'a plan naming a block the package does not have': [{ planBody: { base: BASE, have: [1, 99] } }, {}, ['whole']],
    'a plan out of order': [{ planBody: { base: BASE, have: [2, 1] } }, {}, ['whole']],
    'a plan with no usable base': [{ planBody: { base: 'nope', have: [1] } }, {}, ['whole']],
    'a block-aware upload refused': [{ reuse: 409 }, {}, ['reuse', 'whole']],
    'a block-aware upload failing': [{ reuse: 502 }, {}, ['reuse', 'whole']],
  };
  for (const [name, [cp, params, puts]] of Object.entries(whole)) {
    it(`uploads the whole package: ${name}`, async () => {
      const seen = stubControlPlane(cp);
      await deploy(onDisk('v2.ee', v2), params);
      assert.deepEqual(seen.puts, puts);
      assert.ok(seen.stored.equals(v2.bytes));
      assert.equal(seen.sent.at(-1), v2.bytes.length);
    });
  }

  it('uploads the whole package when there is no record beside it, or the record is for another file', async () => {
    let seen = stubControlPlane();
    await deploy(onDisk('bare.ee', v2, { record: false }));
    assert.deepEqual(seen.puts, ['whole']);
    seen = stubControlPlane();
    const path = onDisk('stale.ee', v2);
    writeFileSync(`${path}.digest.json`, JSON.stringify(v1.digest));
    await deploy(path);
    assert.deepEqual(seen.puts, ['whole']);
  });
});
