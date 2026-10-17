import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// `npx @evolving-edge/ee-cdn-cli ./dist` names no command. npx then runs the
// package's only bin, or the one named for the package without its scope.
// With ee-deploy and ee-domain both present and neither named ee-cdn-cli, it
// fails with "could not determine executable to run" (#558).
test('npx <package> has a command to run', () => {
  const unscoped = pkg.name.split('/').pop();
  const bins = Object.keys(pkg.bin);
  assert.ok(bins.length === 1 || bins.includes(unscoped),
    `package.json has bins ${bins.join(', ')} and none is named "${unscoped}", so npx cannot choose one`);
});

test('the package-named bin is the deploy command', () => {
  assert.equal(pkg.bin['ee-cdn-cli'], pkg.bin['ee-deploy']);
});

test('every bin points at a file that ships', () => {
  for (const [name, path] of Object.entries(pkg.bin)) {
    assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `${name} -> ${path} is missing`);
    assert.ok(pkg.files.some((f) => path.replace('./', '').startsWith(f)), `${path} is not covered by "files"`);
  }
});
