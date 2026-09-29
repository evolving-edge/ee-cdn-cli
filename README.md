# @evolving-edge/ee-cdn-cli

Publish a static site to the [Evolving Edge](https://www.evolvingedge.ai) CDN.

Your build is packaged into a single content-addressed `.ee` workload and sent
to the control plane. Edge nodes resolve your domain to that content hash and
serve it, sourcing bytes from peer nodes in-region before falling back to
origin.

Two ways in: a CLI for any generator, and an Astro integration.

## CLI

Works with anything that emits a directory — Hugo, Eleventy, Jekyll, Zola,
Publii, hand-written HTML.

```bash
npx @evolving-edge/ee-cdn-cli ./public --domain blog.example.com --project proj_abc
```

```
ee-deploy <directory> --domain <host> [options]

  --project <id>    Project ID. Required if your token is project-scoped.
  --level <0|1|2>   Encryption level. Default 0.
  --dry-run         Package but do not upload.
  --help            Everything else.
```

The deploy token comes from the portal (Workload → Deploy Tokens) and is read
from `EE_CDN_TOKEN`; `EE_CDN_PROJECT_ID` and `EE_CDN_BUILD_ID` supply defaults
for `--project` and `--build`.

**Publii**: set deployment to *Manual*, which writes the site to a folder, then
point `ee-deploy` at that folder.

## Astro

```bash
npm install -D @evolving-edge/ee-cdn-cli
```

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import eeCdn from '@evolving-edge/ee-cdn-cli/astro';

export default defineConfig({
  site: 'https://blog.example.com',
  trailingSlash: 'always',        // required — see below
  build: { format: 'directory' }, // required — see below
  integrations: [
    eeCdn({
      deploy: { domain: 'blog.example.com', projectId: 'proj_…' },
    }),
  ],
});
```

Set `EE_CDN_TOKEN` to a deploy token from the portal (Workload → Deploy
Tokens). Nothing else is required — the `ee-builder` binary is downloaded and
cached automatically.

## Put it last in `integrations`

Astro runs `astro:build:done` hooks in integration order, and this one packages
the whole of `dist/`. Any integration that *writes* to `dist/` in its own
`astro:build:done` — `@astrojs/sitemap` is the common one — must run first, or
its output is not in the workload you publish.

This fails silently: `dist/` on disk looks correct afterwards, because the
sitemap is written a moment later. The only visible symptom is that the
deployed site is missing files. To check, compare the hash the integration logs
against an independent one:

```bash
ee-builder -src dist -hash-only    # must equal the logged "Content hash"
```

## Two required Astro settings

`trailingSlash: 'always'` and `build: { format: 'directory' }` are not
stylistic preferences.

Edge nodes resolve request paths **literally**: `index.html` is appended only
when the path already ends in `/`, and there is no `.html` extension fallback.
So `build.format: 'file'` emits `page.html` while linking to `/page`, and
**every page on the site 404s**.

A request for `/page` without the slash 404s too, unless you opt in to the
trailing-slash redirect: add the line `# ee:trailing-slash on` to
`public/_redirects`, and the edge answers `/page` with a 301 to `/page/`. That
rescues links from elsewhere; `trailingSlash: 'always'` keeps your own links
from taking the extra hop. Redirects work on Level 0 sites only.

The integration throws on `format: 'file'` at config time rather than letting
you find out in production, and warns on `trailingSlash: 'never'`.

## Options

| Option | Type | Default | Notes |
|---|---|---|---|
| `deploy` | object | — | Omit to build and validate without publishing. |
| `deploy.domain` | string | — | Hostname edge nodes serve this site on. |
| `deploy.level` | `0 \| 1 \| 2` | `0` | `0` = compressed only. Use `0` for public sites. |
| `deploy.projectId` | string | — | Required if your deploy token is project-scoped. |
| `deploy.buildId` | string | — | Applies the Build Config's server-side defaults. |
| `controlPlane` | string | `https://cp.3dge.app` | |
| `token` | string | `$EE_CDN_TOKEN` | |
| `builderPath` | string | — | Use a local `ee-builder` instead of downloading. |
| `builderVersion` | string | `latest` | |
| `builderChecksum` | string | — | Pin the binary's sha256. |
| `workloads` | array | `[]` | Encrypted sub-bundles. Not needed for a normal site. |
| `workloads[].embedKey` | boolean | `false` | Level 1 only. Bake the key into the built page instead of delivering it out of band. See below. |
| `sdkUrl` | string \| false | `${cdnUrl}/ee.js` | Injected only when `data-ee` elements exist. |
| `upload` | boolean | `true` | |
| `dryRun` | boolean | `false` | Build and hash, stop before uploading. |
| `copyTo` | string | — | Also copy `dist` here. Overwrites in place. |

## Encrypted workloads

For content that should not be served in the clear, build it as a separate
workload and reference it from HTML:

```js
eeCdn({
  workloads: [{ name: 'secure', src: 'secure-content', level: 1 }],
  deploy: { domain: 'app.example.com' },
})
```

```html
<img data-ee="/images/photo1.svg" data-ee-workload="secure" />
```

At build time each `data-ee` element has its workload name rewritten to a
content hash, and the browser SDK is injected into `<body>`. Keys are stable
across deploys as long as the source bytes do not change — that is what
`.ee-cache.json` is for; commit it.

A Level 0 site has no `data-ee` elements, so no script is injected and no
JavaScript ships. That is deliberate.

### Level 1 key delivery

A Level 1 key decrypts client-side and belongs to whoever holds the page — it
is never registered with the control plane, so nothing there can revoke or
audit access to it the way Level 2's short-lived tokens do. Because of that,
the build does **not** write the key into the HTML it produces by default:
every edge node and every cache in front of your site would then be serving
the key in the clear to anyone who requests the page, which defeats the point
of keeping it out of server hands in the first place.

Instead, the build logs each Level 1 workload's key once (`.ee-cache.json`
also keeps a copy locally, keyed by workload) and expects you to deliver it out
of band — typically as a URL fragment, which a conforming browser never sends
to any server:

```html
<script src="https://cdn.3dge.app/ee.js" data-workload="<hash>"></script>
```

```
https://app.example.com/gated-page#key=<the-logged-key>
```

Whoever hands out that link — an email, a purchase confirmation, your own
authenticated redirect — is what gates access; the CDN and edge nodes never
see the key. This is the same shape the portal uses for Level 1 (#208).

If you'd rather have a link that works without a fragment and accept that the
key then reaches every edge node and cache in the clear, set
`workloads[].embedKey: true` on that workload and `data-ee-key` is written into
the page as before.

The `#key=` fragment carries one workload's key at a time. If a single page
references more than one distinct Level 1 workload, only the one matching
fragment resolves automatically — give the others `embedKey: true`, or deliver
each key through your own script before the SDK's auto-init runs.

## ee-builder integrity

The control plane publishes a `.sha256` sidecar for `edge-node` but not for
`ee-builder`. Until it does, the first download's digest is recorded in
`.ee-builder-lock.json` and every later download must match it. **Commit that
lockfile** so CI verifies the same binary you built against. Pass
`builderChecksum` to pin a digest explicitly instead.

Published targets are `linux/amd64`, `linux/arm64`, and `darwin/arm64`. On
anything else, build from source and pass `builderPath`.

## After a deploy

Propagation takes up to about 90 seconds: the control-plane alias cache is 60s,
the edge domain cache 30s, and the node heartbeat 30s.

Deploys are content-addressed and immutable, so rolling back is repointing an
alias — the previous bundle is still there.

## Known CDN limitations

These are properties of the CDN, not of this package:

- **Cache headers are fixed, not configurable.** HTML revalidates on every
  request (`max-age=0, must-revalidate`, with an ETag), files under `_astro/`
  are cached for a year as immutable, and everything else for an hour with
  `stale-while-revalidate`. Level 1 and 2 sites are served `no-cache`.
- **One site-wide 404.** A miss serves your root `404.html` with a 404 status,
  or the platform's own 404 page if you have none. There are no per-directory
  404 pages.
- **The trailing-slash redirect is opt-in.** `/page` 404s where `/page/`
  works, unless `_redirects` contains `# ee:trailing-slash on`.
- **Redirects only, Level 0 only.** A Netlify-format `_redirects` file
  supports 301 and 302 rules; there is no response-header configuration.
- **Static only.** No SSR, no adapters.
- **Custom-domain TLS is manual** (`flyctl certs create`); there is no ACME.

## Releasing

Bump the version in a pull request. When it merges to `main`, CI publishes that version and stops. Any other merge is a no-op, because the workflow asks the registry whether the version in `package.json` is already there.

```bash
npm version minor --no-git-tag-version   # then commit, PR, merge
```

Publishing uses npm trusted publishing (OIDC) — there is no `NPM_TOKEN` anywhere.

**The first publish of a new package cannot use OIDC.** npm hangs trusted publishers off a package's settings page, and a package that has never been published does not have one, so OIDC can publish to a package but cannot create one. An owner of the `evolving-edge` npm org publishes once by hand (`npm login && npm publish`), adds the trusted publisher, and every release after that is automatic. `.github/workflows/publish.yml` carries the exact field values, and CI fails with those instructions in the job summary if it runs before the bootstrap is done.

## License

MIT
