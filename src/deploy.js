/**
 * The deploy path, shared by the CLI and the Astro integration.
 *
 * Everything here is framework-agnostic: given a directory of built files it
 * packages them as a content-addressed .ee workload and PUTs them to the
 * control plane. The Astro integration is one caller; `ee-deploy` is another;
 * Hugo, Eleventy, Publii and anything else that emits a directory go through
 * the CLI.
 *
 * Keeping this in one place matters because the failure modes are subtle — the
 * unverifiable domain binding, the builder checksum, the 100 MiB cap — and we
 * would rather fix them once than twice.
 */
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import {
  DEFAULT_CONTROL_PLANE,
  ensureBuilder,
  runBuilder,
  scratchFile,
} from './builder.js';
import { storeWorkload } from './upload.js';

/**
 * Where a downloaded ee-builder is kept when the caller has nowhere better.
 *
 * The Astro integration passes the project's node_modules/.cache. The CLI runs
 * anywhere — inside a Hugo tree, a Publii output folder, someone's Downloads —
 * so it gets a user-level cache instead of writing into the site directory.
 */
export function defaultCacheDir() {
  const base =
    process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'evolving-edge');
}

/** Params handleWorkloadStoreRaw understands, beyond hash and encryptionLevel. */
const METADATA = [
  'projectId',
  'orgId',
  'projectName',
  'projectSlug',
  'buildName',
  'buildId',
];

/**
 * Package a directory and publish it.
 *
 * Returns { hash, fileCount, uploaded, workloadPath }. workloadPath is only
 * set on a dry run, where the .ee is deliberately left on disk to inspect.
 */
export async function deploySite({
  dir,
  domain,
  name,
  level = 0,
  controlPlane = DEFAULT_CONTROL_PLANE,
  token = process.env.EE_CDN_TOKEN,
  dryRun = false,
  builderPath = null,
  builderVersion = 'latest',
  builderChecksum = null,
  lockfilePath = null,
  cacheDir = defaultCacheDir(),
  metadata = {},
  logger = console,
}) {
  const src = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
  if (!existsSync(src) || !statSync(src).isDirectory()) {
    throw new Error(`Not a directory: ${src}`);
  }
  if (!domain) {
    throw new Error('A domain is required — it is what the edge serves this workload as.');
  }

  mkdirSync(cacheDir, { recursive: true });

  const bin = builderPath
    ? resolveBuilderPath(builderPath)
    : await ensureBuilder({
        controlPlane,
        version: builderVersion,
        checksum: builderChecksum,
        lockfilePath,
        cacheDir,
        logger,
      });

  const out = scratchFile('site.ee');
  logger.info(`Packaging ${src} as a Level ${level} workload…`);
  const result = runBuilder(bin, { src, out, level });
  logger.info(`Content hash ${result.hash}`);

  if (dryRun) {
    logger.info(`Dry run — not uploading. Workload left at ${out}`);
    return { ...result, uploaded: false, workloadPath: out };
  }

  if (!token) {
    rmSync(out, { force: true });
    throw new Error(
      'No deploy token. Set EE_CDN_TOKEN (portal → Workload → Deploy Tokens).',
    );
  }

  const params = {
    domain,
    encryptionLevel: `level${level}`,
    fileCount: result.fileCount,
    name: name ?? domain,
  };
  for (const key of METADATA) {
    if (metadata[key]) params[key] = metadata[key];
  }

  try {
    await storeWorkload({
      filePath: out,
      hash: result.hash,
      controlPlane,
      token,
      params,
      logger,
    });
  } finally {
    rmSync(out, { force: true });
  }

  // Deliberately not "Deployed". The upload is confirmed — the domain binding
  // is not. handleWorkloadStoreRaw treats PutDomainMapping as non-fatal (it
  // logs and returns 200 regardless) and reports nothing about it in the
  // response, so a failed binding is invisible from here. Claiming a deploy on
  // that evidence is how a live 404 reads as a green build.
  logger.info(`Requested domain binding ${domain} → ${result.hash.slice(0, 16)}…`);
  logger.info(
    'Propagation takes up to ~90s (alias cache 60s, edge domain cache 30s, ' +
      'heartbeat 30s). Confirm the binding actually took with:',
  );
  logger.info(`  curl -sS -o /dev/null -w '%{http_code}\\n' https://${domain}/`);

  return { ...result, uploaded: true };
}

function resolveBuilderPath(p) {
  const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
  if (!existsSync(abs)) throw new Error(`builderPath does not exist: ${abs}`);
  return abs;
}
