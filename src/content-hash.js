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
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';

// The files ee-builder leaves out by default (ee-builder/default_excludes.go,
// #398): version-control directories and OS folder metadata. The cache key
// skips them too, so it changes exactly when the bundle would.
const VCS_DIRS = new Set(['.git', '.hg', '.svn']);
const OS_METADATA = new Set(['.DS_Store', 'Thumbs.db']);

/**
 * Hashes a site folder the way ee-builder packages it. Symlinks are followed
 * (#399), as long as they stay inside the folder: a link out, or back into a
 * folder that contains it, throws, matching ee-builder's walkSite. Paths are
 * the ones under the folder, not the link targets.
 */
export function computeDirectoryHash(dirPath) {
  const files = [];
  const realRoot = realpathSync(dirPath);
  const inside = (p) => p === realRoot || p.startsWith(realRoot + sep);

  (function collect(dir, realDir, base, ancestors) {
    const entries = readdirSync(realDir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = join(base, entry.name);
      let real = join(realDir, entry.name);
      if (entry.isSymbolicLink()) {
        real = realpathSync(real);
        if (!inside(real)) {
          throw new Error(`symlink ${full} points outside the site folder (to ${real}); copy the file in instead`);
        }
      }
      const isDir = entry.isSymbolicLink() ? statSync(real).isDirectory() : entry.isDirectory();
      if (isDir) {
        if (VCS_DIRS.has(entry.name)) continue;
        if (ancestors.has(real)) {
          throw new Error(`symlink cycle: ${full} leads back to a folder that contains it`);
        }
        ancestors.add(real);
        collect(full, real, rel, ancestors);
        ancestors.delete(real);
      } else if (!OS_METADATA.has(entry.name)) {
        files.push({ rel, full: real });
      }
    }
  })(dirPath, realRoot, '', new Set([realRoot]));

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
