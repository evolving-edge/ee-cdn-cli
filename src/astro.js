/**
 * @evolving-edge/cdn-cli — publish an Astro site to the Evolving Edge CDN.
 *
 * The build produces `dist/`, which is packaged into a single content-addressed
 * `.ee` workload and PUT to the control plane. Edge nodes resolve your domain
 * to that content hash and serve it, sourcing the bytes from peer nodes before
 * falling back to origin.
 *
 * Minimal usage:
 *
 *   import eeCdn from '@evolving-edge/cdn-cli';
 *
 *   export default defineConfig({
 *     site: 'https://blog.example.com',
 *     trailingSlash: 'always',        // required — see the README
 *     build: { format: 'directory' }, // required — see the README
 *     integrations: [
 *       eeCdn({ deploy: { domain: 'blog.example.com' } }),
 *     ],
 *   });
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CONTROL_PLANE,
  ensureBuilder,
  runBuilder,
  scratchFile,
  toKey,
} from './builder.js';
import { computeDirectoryHash, loadCache, saveCache } from './content-hash.js';
import { findHtmlFiles, transformHtml } from './html.js';
import { deploySite } from './deploy.js';

const DEFAULT_CDN_URL = 'https://cdn.3dge.app';

export default function eeCdn(options = {}) {
  const {
    deploy = null,
    controlPlane = DEFAULT_CONTROL_PLANE,
    token = process.env.EE_CDN_TOKEN,

    builderPath = null,
    builderVersion = 'latest',
    builderChecksum = null,

    workloads = [],
    outputFile = 'src/workloads.json',
    cacheFile = '.ee-cache.json',
    lockfile = '.ee-builder-lock.json',

    sdkUrl = null,
    cdnUrl = DEFAULT_CDN_URL,

    upload = true,
    dryRun = false,

    copyTo = null,
  } = options;

  const resolvedSdkUrl =
    sdkUrl === false ? null : (sdkUrl ?? `${cdnUrl}/ee.js`);

  let projectRoot = '';
  let cacheDir = '';
  let builder = null;
  let workloadData = {};
  let cache = {};

  /** Resolve the builder once, lazily — a dry run never needs it. */
  async function builderBin(logger) {
    if (builder) return builder;
    if (builderPath) {
      const abs = join(projectRoot, builderPath);
      if (!existsSync(abs)) {
        throw new Error(`builderPath does not exist: ${abs}`);
      }
      builder = abs;
      return builder;
    }
    builder = await ensureBuilder({
      controlPlane,
      version: builderVersion,
      checksum: builderChecksum,
      lockfilePath: join(projectRoot, lockfile),
      cacheDir,
      logger,
    });
    return builder;
  }

  return {
    name: '@evolving-edge/cdn-cli',
    hooks: {
      'astro:config:setup': ({ config, logger }) => {
        projectRoot = fileURLToPath(config.root);
        cacheDir = join(projectRoot, 'node_modules', '.cache', 'evolving-edge');
        cache = loadCache(join(projectRoot, cacheFile));

        // These are not stylistic preferences. ee-cdn appends index.html only
        // when a path already ends in "/", with no .html fallback and no
        // redirect, so 'file' format 404s every page on the site.
        if (config.build?.format === 'file') {
          throw new Error(
            "[@evolving-edge/cdn-cli] build.format: 'file' is incompatible with " +
              'ee-cdn: it emits page.html but links to /page, and the edge ' +
              'resolves paths literally, so every page would 404. Use ' +
              "build.format: 'directory' with trailingSlash: 'always'.",
          );
        }
        if (config.trailingSlash === 'never') {
          logger.warn(
            "trailingSlash: 'never' will 404 on ee-cdn — the edge only " +
              "appends index.html to paths ending in '/'. Use 'always'.",
          );
        }
        if (deploy?.domain && !token && upload && !dryRun) {
          logger.warn(
            'No deploy token found. Set EE_CDN_TOKEN or pass `token`; the ' +
              'build will fail at upload time.',
          );
        }
      },

      // Encrypted sub-workloads are built before the site so their hashes and
      // keys can be woven into the HTML that references them.
      'astro:build:start': async ({ logger }) => {
        if (workloads.length === 0) return;

        const bin = await builderBin(logger);
        const built = {};

        for (const workload of workloads) {
          const src = join(projectRoot, workload.src);
          if (!existsSync(src)) {
            throw new Error(
              `Workload "${workload.name}" source not found: ${src}`,
            );
          }

          const level = workload.level ?? 0;
          const contentHash = computeDirectoryHash(src);
          const cacheKey = `${workload.name}:${contentHash}`;
          const hit = cache[cacheKey];

          // Reuse the previous build when the source is byte-identical, so a
          // Level 1 workload keeps a stable key across deploys.
          if (hit?.hash && (level === 0 || hit.key)) {
            logger.info(`${workload.name}: unchanged, reusing ${hit.hash.slice(0, 16)}…`);
            built[workload.name] = { hash: hit.hash, key: hit.key ?? undefined };
            continue;
          }

          const out = scratchFile(`${workload.name}.ee`);
          const result = runBuilder(bin, { src, out, level });

          if (level >= 1 && (!result.secret || !result.salt)) {
            throw new Error(
              `Workload "${workload.name}" is Level ${level} but ee-builder ` +
                'returned no secret/salt.',
            );
          }

          const entry = { hash: result.hash };
          if (level >= 1) entry.key = toKey(result.secret, result.salt);
          built[workload.name] = entry;

          if (upload && !dryRun) {
            await storeWorkload({
              filePath: out,
              hash: result.hash,
              controlPlane,
              token,
              params: {
                name: workload.name,
                encryptionLevel: `level${level}`,
                fileCount: result.fileCount,
                projectId: deploy?.projectId,
                orgId: deploy?.orgId,
                buildId: deploy?.buildId,
              },
              logger,
            });
          }

          cache[cacheKey] = {
            hash: entry.hash,
            key: entry.key ?? null,
            builtAt: new Date().toISOString(),
          };
          rmSync(out, { force: true });
        }

        workloadData = built;

        const outputPath = join(projectRoot, outputFile);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, `${JSON.stringify(built, null, 2)}\n`);
        saveCache(join(projectRoot, cacheFile), cache);
      },

      'astro:build:done': async ({ dir, logger }) => {
        const distPath = fileURLToPath(dir);

        // Weave workload hashes/keys into any data-ee elements. No-op for a
        // Level 0 site, which has none.
        if (Object.keys(workloadData).length > 0) {
          const defaultWorkload = Object.keys(workloadData)[0];
          let count = 0;
          for (const file of findHtmlFiles(distPath)) {
            if (await transformHtml(file, workloadData, defaultWorkload, resolvedSdkUrl)) {
              count++;
            }
          }
          if (count) logger.info(`Rewrote ${count} HTML file(s) with workload keys`);

          // A local sdkUrl means the SDK must actually be in the bundle.
          if (resolvedSdkUrl && !resolvedSdkUrl.startsWith('http')) {
            for (const asset of ['ee.js', 'ee-worker.js']) {
              if (!existsSync(join(distPath, asset))) {
                throw new Error(
                  `sdkUrl is "${resolvedSdkUrl}" but ${asset} is not in dist. ` +
                    `Add it to public/, or set sdkUrl to a CDN URL, or ` +
                    `sdkUrl: false to skip injection.`,
                );
              }
            }
          }
        }

        if (copyTo) {
          const dest = join(projectRoot, copyTo);
          mkdirSync(dest, { recursive: true });
          // Overwrite in place. The previous integration deleted every entry
          // in the destination first, which made a mistyped path destructive.
          cpSync(distPath, dest, { recursive: true });
          logger.info(`Copied dist to ${dest}`);
        }

        if (!deploy?.domain) return;

        await deploySite({
          dir: distPath,
          domain: deploy.domain,
          name: deploy.name,
          level: deploy.level ?? 0,
          controlPlane,
          token,
          // `upload: false` packages nothing and uploads nothing; a dry run
          // packages but stops short of the network.
          dryRun: dryRun || !upload,
          builderPath: builderPath ? join(projectRoot, builderPath) : null,
          builderVersion,
          builderChecksum,
          lockfilePath: join(projectRoot, lockfile),
          cacheDir,
          metadata: {
            projectId: deploy.projectId,
            orgId: deploy.orgId,
            projectName: deploy.projectName,
            projectSlug: deploy.projectSlug,
            buildName: deploy.buildName,
            buildId: deploy.buildId,
          },
          logger,
        });
      },
    },
  };
}
