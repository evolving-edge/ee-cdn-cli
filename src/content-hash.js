/**
 * Deterministic directory hashing and the stable-key cache.
 *
 * Carried over from the original integration essentially unchanged — it was
 * the part that worked. The hash covers every file's relative path and bytes,
 * sorted, so it is stable across machines and checkouts.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export function computeDirectoryHash(dirPath) {
  const files = [];

  (function collect(dir, base = '') {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = join(base, entry.name);
      if (entry.isDirectory()) collect(full, rel);
      else files.push({ rel, full });
    }
  })(dirPath);

  files.sort((a, b) => a.rel.localeCompare(b.rel));

  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.rel);
    hash.update(readFileSync(file.full));
  }
  return hash.digest('hex');
}

export function loadCache(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function saveCache(path, cache) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`);
}
