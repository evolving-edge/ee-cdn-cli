import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

// action.yml is the GitHub Action published from ee-cdn-cli's root (#252).
// Nothing in CI runs it, so these tests hold it to the CLI it wraps: every
// input it reads is declared, every flag it passes exists, and its deploy
// step turns inputs into the arguments it should.

const root = fileURLToPath(new URL('..', import.meta.url));
const action = readFileSync(join(root, 'action.yml'), 'utf8');
const scratch = mkdtempSync(join(tmpdir(), 'ee-action-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function declaredInputs() {
  const block = action.slice(action.indexOf('\ninputs:\n'), action.indexOf('\noutputs:\n'));
  return [...block.matchAll(/^ {2}([a-z-]+):$/gm)].map((m) => m[1]);
}

// The deploy step's `run: |` body, with its YAML indentation removed.
function deployScript() {
  const step = action.slice(action.indexOf('id: deploy'));
  const body = step.slice(step.indexOf('run: |\n') + 'run: |\n'.length);
  return body
    .split('\n')
    .filter((line, i, all) => line.startsWith('        ') || (line === '' && i < all.length - 1))
    .map((line) => line.slice(8))
    .join('\n');
}

// Runs the deploy step with a stand-in ee-deploy that records its argv.
function runDeploy(env) {
  const actionPath = join(scratch, `action-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(actionPath, 'bin'), { recursive: true });
  const argvFile = join(actionPath, 'argv.json');
  writeFileSync(
    join(actionPath, 'bin', 'ee-deploy.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  const output = join(actionPath, 'github-output');
  writeFileSync(output, '');
  const res = spawnSync('bash', ['-eo', 'pipefail', '-c', deployScript()], {
    cwd: scratch,
    env: {
      PATH: process.env.PATH,
      ACTION_PATH: actionPath,
      GITHUB_OUTPUT: output,
      DEPLOY_DOMAIN: 'blog.example.com',
      DEPLOY_LEVEL: '0',
      ...env,
    },
    encoding: 'utf8',
  });
  let argv = null;
  try {
    argv = JSON.parse(readFileSync(argvFile, 'utf8'));
  } catch {}
  return { status: res.status, stdout: res.stdout, argv, output: readFileSync(output, 'utf8') };
}

describe('action.yml', () => {
  it('declares every input it reads, and reads every input it declares', () => {
    const declared = declaredInputs();
    const used = new Set([...action.matchAll(/inputs\.([a-z-]+)/g)].map((m) => m[1]));
    for (const name of used) assert.ok(declared.includes(name), `inputs.${name} is used but not declared`);
    for (const name of declared) assert.ok(used.has(name), `input ${name} is declared but never used`);
  });

  it('passes only flags ee-deploy has', () => {
    const help = execFileSync(process.execPath, [join(root, 'bin', 'ee-deploy.js'), '--help'], { encoding: 'utf8' });
    const flags = new Set([...deployScript().matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1]));
    assert.ok(flags.size >= 10, `found only ${flags.size} flags; the script parser is broken`);
    for (const flag of flags) assert.match(help, new RegExp(`--${flag}\\b`), `ee-deploy --help does not list --${flag}`);
  });

  it('turns every input into its flag', () => {
    const r = runDeploy({
      DEPLOY_LEVEL: '2',
      DEPLOY_NAME: 'Blog',
      DEPLOY_TRAILING_SLASH: 'true',
      DEPLOY_CLEAN_URLS: 'true',
      DEPLOY_IMAGES: 'webp',
      DEPLOY_IMAGE_HOSTS: 'www.example.com, cdn.example.com\n old.example.com',
      DEPLOY_IMAGE_REPORT: 'report.json',
      DEPLOY_IMAGE_MAX_WIDTH: '2560',
      DEPLOY_BUILDER_VERSION: '0.3.1',
      DEPLOY_DIRECTORY: 'public',
    });
    assert.equal(r.status, 0, r.stdout);
    assert.deepEqual(r.argv, [
      '--domain=blog.example.com', '--level=2',
      '--name=Blog',
      '--trailing-slash', '--clean-urls',
      '--images=webp',
      '--image-host=www.example.com', '--image-host=cdn.example.com', '--image-host=old.example.com',
      '--image-report=report.json',
      '--image-max-width=2560',
      '--builder-version=0.3.1',
      '--', 'public',
    ]);
    assert.equal(r.output, 'url=https://blog.example.com\n');
  });

  it('passes only the domain and level when nothing else is set', () => {
    const r = runDeploy({ DEPLOY_TRAILING_SLASH: 'false', DEPLOY_CLEAN_URLS: 'false', DEPLOY_DRY_RUN: 'false' });
    assert.equal(r.status, 0, r.stdout);
    assert.deepEqual(r.argv, ['--domain=blog.example.com', '--level=0']);
  });

  it('a dry run passes --dry-run and sets no url', () => {
    const r = runDeploy({ DEPLOY_DRY_RUN: 'true' });
    assert.equal(r.status, 0, r.stdout);
    assert.ok(r.argv.includes('--dry-run'));
    assert.equal(r.output, '');
  });

  it('refuses Level 1 before running ee-deploy', () => {
    const r = runDeploy({ DEPLOY_LEVEL: '1' });
    assert.notEqual(r.status, 0);
    assert.equal(r.argv, null, 'ee-deploy ran');
    assert.match(r.stdout, /Level 1 is not supported here/);
  });

  it('refuses every level but "0" and "2", without passing it to anything', () => {
    const levels = ['01', '1.0', ' 1 ', '1e0', '0x1', '', '3', '00', '2.0', 'two',
      '--eval=process.stdout.write("INJECTED")', '$(echo INJECTED)', '`echo INJECTED`'];
    for (const level of levels) {
      const r = runDeploy({ DEPLOY_LEVEL: level });
      assert.notEqual(r.status, 0, `level ${JSON.stringify(level)} was accepted`);
      assert.equal(r.argv, null, `ee-deploy ran for level ${JSON.stringify(level)}`);
      assert.match(r.stdout, /::error::level must be 0 or 2/, `level ${JSON.stringify(level)}`);
      assert.doesNotMatch(r.stdout, /^INJECTED/m, `level ${JSON.stringify(level)} was executed`);
    }
  });

  it('keeps option-shaped inputs as values', () => {
    const r = runDeploy({
      DEPLOY_DIRECTORY: '--control-plane=https://evil.example',
      DEPLOY_NAME: '--dry-run',
      DEPLOY_IMAGE_HOSTS: '--level=1',
      DEPLOY_IMAGE_MAX_WIDTH: '--dry-run',
    });
    assert.equal(r.status, 0, r.stdout);
    // ee-deploy parses with node:util parseArgs: "--x=value" is always a value,
    // and everything after "--" is a positional.
    const { values, positionals } = parseArgs({
      args: r.argv,
      allowPositionals: true,
      strict: false,
    });
    assert.deepEqual(positionals, ['--control-plane=https://evil.example']);
    assert.equal(values.name, '--dry-run');
    assert.equal(values['image-host'], '--level=1');
    assert.equal(values['image-max-width'], '--dry-run');
    assert.equal(values.level, '0');
    assert.equal(values['control-plane'], undefined);
    assert.equal(values['dry-run'], undefined);
  });

  it('does not expand a glob in image-hosts', () => {
    writeFileSync(join(scratch, 'should-not-appear'), '');
    const r = runDeploy({ DEPLOY_IMAGE_HOSTS: '*' });
    assert.equal(r.status, 0, r.stdout);
    assert.deepEqual(r.argv.slice(-1), ['--image-host=*']);
  });
});
