import type { AstroIntegration } from 'astro';

/** An encrypted sub-bundle built alongside the site. */
export interface EEWorkload {
  /** Referenced from HTML via `data-ee-workload="<name>"`. */
  name: string;
  /** Directory to package, relative to the project root. */
  src: string;
  /**
   * 0 = compressed only, 1 = client-side decryption (key travels with the
   * page), 2 = gateway decryption via a short-lived access token.
   * @default 0
   */
  level?: 0 | 1 | 2;
}

export interface EEDeployOptions {
  /** The hostname edge nodes will serve this site on. */
  domain: string;
  /** Encryption level for the site bundle itself. @default 0 */
  level?: 0 | 1 | 2;
  /** Required when your deploy token is project-scoped. */
  projectId?: string;
  orgId?: string;
  /** Applies the Build Config's server-side defaults. */
  buildId?: string;
  /** Together these form the stable "latest" alias. */
  projectSlug?: string;
  buildName?: string;
  projectName?: string;
  /** Display name for the workload. @default deploy.domain */
  name?: string;
}

export interface EEOptions {
  /** Omit to build and validate without publishing. */
  deploy?: EEDeployOptions;
  /** @default 'https://cp.3dge.app' */
  controlPlane?: string;
  /** Deploy token. @default process.env.EE_CDN_TOKEN */
  token?: string;

  /** Use a local ee-builder instead of downloading one. Relative to root. */
  builderPath?: string;
  /** @default 'latest' */
  builderVersion?: string;
  /** Pin the binary's sha256. Without it, first download is trusted and pinned. */
  builderChecksum?: string;

  /** Encrypted sub-bundles. Leave empty for an ordinary static site. */
  workloads?: EEWorkload[];
  /** Where workload hashes/keys are written. @default 'src/workloads.json' */
  outputFile?: string;
  /** Stable-key cache. @default '.ee-cache.json' */
  cacheFile?: string;
  /** ee-builder checksum lockfile. @default '.ee-builder-lock.json' */
  lockfile?: string;

  /**
   * URL of the browser SDK, injected only when `data-ee` elements exist.
   * `false` disables injection. @default `${cdnUrl}/ee.js`
   */
  sdkUrl?: string | false;
  /** @default 'https://cdn.3dge.app' */
  cdnUrl?: string;

  /** Set false to build and package without uploading. @default true */
  upload?: boolean;
  /** Build and hash, then stop before uploading. @default false */
  dryRun?: boolean;
  /** Also copy dist to this path, relative to root. Overwrites in place. */
  copyTo?: string;
}

/**
 * Package an Astro build as an Evolving Edge `.ee` workload and publish it.
 *
 * Requires `build.format: 'directory'` and `trailingSlash: 'always'` — the
 * edge resolves paths literally and `'file'` format would 404 every page.
 */
export default function eeCdn(options?: EEOptions): AstroIntegration;
