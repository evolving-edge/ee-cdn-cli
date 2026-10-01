/**
 * Find a project's build output when no directory is given (#404).
 *
 * Detected from the project, never from folder names alone: public/ is
 * Hugo's output but Astro's and Vite's static *source* folder, so guessing by
 * name would deploy a folder of favicons. Refuses to guess when no marker
 * matches, two do, or the folder isn't there with an index.html in it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** The package.json dependencies the markers look at. */
function deps(cwd) {
  const pkg = readJSON(join(cwd, 'package.json'));
  if (!pkg) return new Set();
  return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
}

function nextIsStaticExport(cwd) {
  for (const f of ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs']) {
    if (/output\s*:\s*['"]export['"]/.test(read(join(cwd, f)))) return true;
  }
  return false;
}

/**
 * Each marker: a label, a test on the project, and the output folder (or a
 * function choosing one, or an error when the project can't be deployed as
 * it stands).
 */
function markers(cwd) {
  const d = deps(cwd);
  const has = (f) => existsSync(join(cwd, f));
  const hugoConfig = ['hugo.toml', 'hugo.yaml', 'hugo.yml', 'hugo.json'].some(has) ||
    (has('config.toml') && /\b(baseURL|theme)\b/.test(read(join(cwd, 'config.toml'))) && !/\bbase_url\b/.test(read(join(cwd, 'config.toml'))));
  const zolaConfig = (has('config.toml') && /\bbase_url\b/.test(read(join(cwd, 'config.toml')))) || has('zola.toml');
  const viteOnly = d.has('vite') && !['astro', 'nuxt', 'vitepress', '@sveltejs/kit', '@docusaurus/core'].some((x) => d.has(x));
  return [
    { label: 'Astro', match: d.has('astro'), out: 'dist' },
    {
      label: 'Next.js',
      match: d.has('next'),
      out: nextIsStaticExport(cwd) ? 'out' : null,
      refuse: "Next.js deploys here only as a static export: set output: 'export' in next.config, build, then deploy ./out",
    },
    { label: 'Nuxt', match: d.has('nuxt'), out: '.output/public' },
    { label: 'SvelteKit (adapter-static)', match: d.has('@sveltejs/adapter-static'), out: 'build' },
    { label: 'Docusaurus', match: d.has('@docusaurus/core'), out: 'build' },
    { label: 'VitePress', match: d.has('vitepress'), out: has('docs/.vitepress') ? 'docs/.vitepress/dist' : '.vitepress/dist' },
    { label: 'Gatsby', match: d.has('gatsby'), out: 'public' },
    { label: 'Hexo', match: d.has('hexo'), out: 'public' },
    { label: 'Eleventy', match: d.has('@11ty/eleventy'), out: '_site' },
    { label: 'Hugo', match: hugoConfig, out: 'public' },
    { label: 'Jekyll', match: has('_config.yml') && /jekyll/.test(read(join(cwd, 'Gemfile'))), out: '_site' },
    { label: 'MkDocs', match: has('mkdocs.yml'), out: 'site' },
    { label: 'mdBook', match: has('book.toml'), out: 'book' },
    { label: 'Sphinx', match: has('conf.py') && /sphinx/i.test(read(join(cwd, 'conf.py'))), out: '_build/html' },
    { label: 'Zola', match: zolaConfig, out: 'public' },
    { label: 'Vite', match: viteOnly, out: 'dist' },
  ];
}

/**
 * Returns { dir, label } for the one project found in cwd, or throws an
 * Error explaining what was found and asking for the directory.
 */
export function detectOutputDir(cwd = process.cwd()) {
  const found = markers(cwd).filter((m) => m.match);
  const ask = 'Pass the directory to deploy, for example: ee-deploy ./dist --domain example.com';
  if (found.length === 0) {
    throw new Error(`No directory given, and no known site generator found in ${cwd}. ${ask}`);
  }
  if (found.length > 1) {
    throw new Error(`No directory given, and this project looks like more than one generator (${found.map((m) => m.label).join(', ')}). ${ask}`);
  }
  const [m] = found;
  if (!m.out) throw new Error(`${m.refuse}. ${ask}`);
  const dir = join(cwd, m.out);
  if (!existsSync(join(dir, 'index.html'))) {
    throw new Error(`Detected ${m.label}, but ${m.out}/index.html doesn't exist. Build the site first, or ${ask.charAt(0).toLowerCase()}${ask.slice(1)}`);
  }
  return { dir, rel: m.out, label: m.label };
}
