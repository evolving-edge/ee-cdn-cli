# @evolving-edge/cdn-cli

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
npx @evolving-edge/cdn-cli ./public --domain blog.example.com --project proj_abc
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
npm install -D @evolving-edge/cdn-cli
```

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import eeCdn from '@evolving-edge/cdn-cli/astro';

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
when the path already ends in `/`. There is no `.html` extension fallback and
no trailing-slash redirect. So `build.format: 'file'` emits `page.html` while
linking to `/page`, and **every page on the site 404s**.

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
content hash, a `data-ee-key` added for Level 1, and the browser SDK injected
into `<body>`. Keys are stable across deploys as long as the source bytes do
not change — that is what `.ee-cache.json` is for; commit it.

A Level 0 site has no `data-ee` elements, so no script is injected and no
JavaScript ships. That is deliberate.

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

- **`Cache-Control: no-cache`** on every edge-served file, including immutable
  hashed assets.
- **No custom 404.** A miss returns plain text; your `404.html` is not served.
- **No trailing-slash redirect.** `/page` 404s where `/page/` works.
- **No redirect or response-header configuration.**
- **Static only.** No SSR, no adapters.
- **Custom-domain TLS is manual** (`flyctl certs create`); there is no ACME.

## Releasing

Publishing is done by CI via npm trusted publishing — there is no `NPM_TOKEN`
anywhere. Tag a version and push:

```bash
npm version minor && git push --follow-tags
```

See `.github/workflows/publish.yml` for the one-time npmjs.com setup.

## License

MIT
