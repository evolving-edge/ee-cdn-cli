/**
 * Routing pragmas in the site's _redirects (#394, #395, #396).
 *
 * The edge's trailing-slash and clean-URLs rules are opt-in, declared by a
 * comment line in _redirects (docs/redirects.md). These flags write that line
 * into the build output, so the setting travels inside the bundle and
 * versions, deploys and rolls back with the content, rather than depending
 * on how the bundle was built.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PRAGMAS = {
  trailingSlash: 'ee:trailing-slash',
  cleanUrls: 'ee:clean-urls',
};

/** The value a comment line gives a pragma ('on', 'off', …), or null. */
function pragmaValue(line, name) {
  const t = line.trim();
  if (!t.startsWith('#')) return null;
  const body = t.slice(1).trim();
  if (!body.startsWith(name)) return null;
  return body.slice(name.length).trim() || 'on';
}

/**
 * Make sure dir/_redirects declares each requested pragma.
 *
 * - Creates the file when it's missing.
 * - Inserts the pragma at the top when the file doesn't mention it.
 * - Leaves the file alone when the pragma is already there with any value:
 *   an explicit "off" in the site's own file wins over the flag, with a
 *   warning.
 * - Never reorders or rewrites rules.
 *
 * Returns the lines it reported, for tests.
 */
export function ensurePragmas(dir, wanted = {}, logger = console) {
  const names = Object.keys(PRAGMAS).filter((k) => wanted[k]).map((k) => PRAGMAS[k]);
  if (names.length === 0) return [];
  const file = join(dir, '_redirects');
  const existed = existsSync(file);
  const body = existed ? readFileSync(file, 'utf8') : '';
  const lines = body.split('\n');
  const notes = [];
  const add = [];
  for (const name of names) {
    const value = lines.map((l) => pragmaValue(l, name)).find((v) => v !== null);
    if (value === undefined) {
      add.push(`# ${name} on`);
    } else if (value !== 'on' && value !== 'true') {
      const msg = `_redirects: keeping the site's "# ${name} ${value}"; it overrides the flag`;
      logger.warn(msg);
      notes.push(msg);
    }
  }
  if (add.length === 0) return notes;
  const next = add.join('\n') + '\n' + body;
  writeFileSync(file, existed ? next : add.join('\n') + '\n');
  for (const line of add) {
    const msg = `_redirects: ${existed ? 'added' : 'created with'} "${line}"`;
    logger.info(msg);
    notes.push(msg);
  }
  return notes;
}
