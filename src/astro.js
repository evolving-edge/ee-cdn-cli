/**
 * @evolving-edge/ee-cdn-cli — publish an Astro site to the Evolving Edge CDN.
 *
 * The build produces `dist/`, which is packaged into a single content-addressed
 * `.ee` workload and PUT to the control plane. Edge nodes resolve your domain
 * to that content hash and serve it, sourcing the bytes from peer nodes before
 * falling back to origin.
 *
 * Minimal usage:
 *
 *   import eeCdn from '@evolving-edge/ee-cdn-cli';
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
import { storeWorkload } from './upload.js';

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
    name: '@evolving-edge/ee-cdn-cli',
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
            "[@evolving-edge/ee-cdn-cli] build.format: 'file' is incompatible with " +
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

        // Gated on a deploy target, matching the site-level guard in
        // astro:build:done and the README, which says omitting `deploy` builds
        // and validates without publishing. This asked only whether uploading
        // was enabled, so a config with workloads and no deploy target
        // published every sub-workload anyway -- and demanded a token to do it
        // -- which is the one thing the caller had asked not to happen.
        const willUpload = upload && !dryRun && Boolean(deploy?.domain);

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
          // Level 1 only -- see the note at the point this is consumed in
          // html.js. Defaults to false: a Level 1 key must be delivered out of
          // band (URL fragment) unless the caller explicitly accepts what
          // baking it into the page costs.
          const embedKey = workload.embedKey ?? false;
          const contentHash = computeDirectoryHash(src);
          // The level is part of a build's identity, not a property of it: the
          // same bytes at Level 1 and Level 2 are different .ee files. Keying
          // on name and content alone let a Level 1 entry satisfy a Level 2
          // build -- same name, same bytes, and `hit.key` present from the
          // Level 1 run -- so the build was skipped, the upload with it, and
          // the secret this PR exists to register was never sent. The cache
          // quietly reproduced the bug the rest of the change fixes.
          const cacheKey = `${workload.name}:level${level}:${contentHash}`;
          const hit = cache[cacheKey];

          // Reuse the previous build when the source is byte-identical, so a
          // Level 1 workload keeps a stable key across deploys. Only Level 1
          // has a key to preserve; asking for one at Level 2 would mean never
          // reusing anything, since Level 2 no longer stores one.
          //
          // A hit also has to have been uploaded. The .ee is deleted after each
          // build, so a hit has nothing left to send -- and reusing one that was
          // only ever built locally (a dry run, or an earlier build that did not
          // upload) skips the one upload that would have registered the secret.
          const reusable = hit?.hash && (level !== 1 || hit.key);
          if (reusable && (!willUpload || hit.uploaded)) {
            logger.info(`${workload.name}: unchanged, reusing ${hit.hash.slice(0, 16)}…`);
            built[workload.name] = {
              hash: hit.hash,
              level,
              key: hit.key ?? undefined,
              embedKey,
            };
            if (level === 1 && !embedKey) {
              logger.warn(
                `${workload.name}: Level 1 key (not embedded in HTML, embedKey is off) — ${hit.key}`,
              );
            }
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

          // Level 1 only. Level 1 is client-side decryption: the key belongs
          // to whoever holds the page and must never reach a server. Level 2 is
          // the opposite arrangement -- the control plane holds the secret and
          // issues short-lived, revocable access tokens per request -- so
          // deriving a key here at all is what defeated it: html.js writes any
          // key it is given into the markup, handing the browser the long-lived
          // material the gateway model exists to withhold (#262).
          const entry = { hash: result.hash, level, embedKey };
          if (level === 1) entry.key = toKey(result.secret, result.salt);
          built[workload.name] = entry;

          // A Level 1 key that isn't going into the page has to reach the
          // operator some other way, or this just silently drops it (#241).
          // It's already in workloads.json for anything that reads that file
          // at build time; this is the one place it also reaches the console,
          // matching #235's "return the key, don't drop it" for the portal.
          if (level === 1 && !embedKey) {
            logger.warn(
              `${workload.name}: Level 1 key (not embedded in HTML, embedKey is off) — ${entry.key}`,
            );
          }

          if (willUpload) {
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
              // Level 2 only -- see secretHeader in upload.js. Without this the
              // control plane stores ciphertext it holds no key for.
              secret: level === 2 ? result.secret : null,
              logger,
            });
          }

          cache[cacheKey] = {
            hash: entry.hash,
            level,
            key: entry.key ?? null,
            uploaded: willUpload,
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
          // Astro links with a trailing slash (trailingSlash: 'always' is
          // required), but a bare /about from anywhere else 404s without the
          // edge's trailing-slash rule. On unless deploy.trailingSlash is
          // false (#396).
          trailingSlash: deploy.trailingSlash ?? true,
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
