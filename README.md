# @evolving-edge/ee-cdn-cli

Publish a static site to the [Evolving Edge](https://www.evolvingedge.ai) CDN.

Your build is packaged into a single content-addressed `.ee` workload and sent
to the control plane. Edge nodes resolve your domain to that content hash and
serve it, sourcing bytes from peer nodes in-region before falling back to
origin.

Three ways in: a CLI for any generator, a GitHub Action that wraps it, and an Astro integration.

## CLI

Works with anything that emits a directory — Hugo, Eleventy, Jekyll, Zola,
Publii, hand-written HTML.

```bash
npx @evolving-edge/ee-cdn-cli ./public --domain blog.example.com --project proj_abc
```

```
ee-deploy [directory] --domain <host> [options]

  --project <id>           Project ID. Required if your token is project-scoped.
  --level <0|1|2>          Encryption level. Default 0.
  --trailing-slash         Redirect /about to /about/.
  --clean-urls             Serve /about from about.html.
  --images <webp|avif|off> Convert JPEG and PNG images while packaging.
  --image-host <host>      Another host the site is served from (repeatable).
  --image-report <path>    Write the conversion report as JSON.
  --image-max-width <px>   Scale images wider than <px> down to that width.
  --builder-version <v>    Pin ee-builder instead of using "latest".
  --dry-run                Package but do not upload.
  --help                   Everything else.
```

**The directory is optional.** Without it, `ee-deploy` finds the build output from the project itself (`package.json` dependencies or the generator's config file): Astro, Next.js static export, Nuxt, SvelteKit, Docusaurus, VitePress, Gatsby, Hexo, Eleventy, Hugo, Jekyll, MkDocs, mdBook, Sphinx, Zola and Vite. It prints what it chose (`Deploying ./dist (detected: Astro)`), and it never guesses: with no match, two matches, or no `index.html` in the folder, it stops and asks for the directory.

**Routing flags.** Most generators link to `/about` while writing `about/index.html`; `--trailing-slash` makes the edge redirect `/about` to `/about/`. Generators that write `about.html` instead (Quartz, Observable Framework, vite-ssg, VitePress with `cleanUrls`) want `--clean-urls`. Each flag writes its line into the output's `_redirects` (creating the file if needed), so the setting travels with the bundle. A site whose own `_redirects` already sets the pragma keeps its value, `off` included.

**Image conversion.** `--images webp` (or `avif`) has ee-builder convert the site's JPEG and PNG images while packaging and rewrite every page, stylesheet, feed, `_redirects` and `_headers` reference to the new names; an image it cannot rewrite every reference to stays as it is, with the reason in the report. Lossy formats store a re-encoded copy of each photo (PNGs are lossless by default). `--domain` always counts as the site's own host, so absolute URLs on it are rewritten; add any other host the site is served from with `--image-host`, once per host. ee-builder prints a readable report on stderr, and `--image-report` also writes the whole report as JSON. `--images off` overrides an `"images"` setting in the site's `ee.jsonc`, which otherwise applies on its own. Image options need an ee-builder with the `-images` flag (`ee-builder -h` lists it); the CLI checks before packaging and stops with a message if the builder is older. It checks too when no option is given but the site's `ee.jsonc` turns conversion on (`"images"` set to `webp`, `avif` or an object), since an older builder would ignore that setting and package the images unconverted. To deploy with such a builder without converting, set `"images": "off"` in `ee.jsonc` (or remove it) and pass no image option, since `--images off` is itself a flag an older builder lacks. The ee-builder published on 2026-10-23 (`c64bedcb850a`) and later have image conversion; with an older one, build ee-builder from source and pass it with `--builder`. See [docs/image-conversion.md](https://github.com/evolving-edge/ee-cdn/blob/main/docs/image-conversion.md) in ee-cdn for what converts, what is left alone and why.

**Resizing images.** `--image-max-width 2560` has ee-builder scale every JPEG and PNG wider than 2,560 pixels down to 2,560 wide while packaging, keeping the aspect ratio, before any conversion. **It changes the image files that are deployed**: each keeps its name and format but is re-encoded smaller (JPEG at quality 85, PNG losslessly). Your build output and repository are never written to. Nothing is enlarged, a result that isn't smaller is discarded, and images it can't handle safely (animated PNGs, CMYK, colour profiles other than sRGB) are left as they are; GIF and SVG are never touched. It is off unless given. With `--images`, the resized files are what gets converted. The log lists each resized image with its size before and after. Pages are not changed, so a `srcset` width (`photo.jpg 4000w`) or an `og:image:width` still states the original width; pick a limit at or above the widest one your generator writes. It needs an ee-builder with the `-image-max-width` flag, which came after image conversion; the CLI checks before packaging. It doesn't lift the 100 MiB deploy limit on its own: a site's many smaller images still count.

**Pin ee-builder in CI.** By default the CLI downloads the latest `ee-builder` and records its checksum in `.ee-builder-lock.json`. With "latest" plus a committed lockfile, every new builder release fails the deploy with a checksum mismatch, by design. Pin a version instead (`--builder-version` or `EE_BUILDER_VERSION`, using the label from the "Upload ee-builder to CDN" run summary), and commit the lockfile.

The deploy token comes from the portal (Workload → Deploy Tokens) and is read
from `EE_CDN_TOKEN`; `EE_CDN_PROJECT_ID` and `EE_CDN_BUILD_ID` supply defaults
for `--project` and `--build`.

**Publii**: set deployment to *Manual*, which writes the site to a folder, then
point `ee-deploy` at that folder.

## GitHub Action

For CI that has no Node of its own (Hugo, Zola, Jekyll, Pelican, mdBook, Sphinx, MkDocs, Quarto and others usually build on Go, Ruby, Python or Rust images), this repository is also a GitHub Action. It runs `ee-deploy` from this package and brings its own Node, so the workflow needs no `actions/setup-node` step and no `npm install`:

```yaml
- uses: actions/checkout@v5
- uses: peaceiris/actions-hugo@v3
  with:
    hugo-version: 'latest'
- run: hugo --minify
- uses: evolving-edge/ee-cdn-cli@vX.Y.Z
  with:
    directory: public
    domain: blog.example.com
    project: proj_abc
    token: ${{ secrets.EE_CDN_TOKEN }}
    builder-version: 'X.Y.Z'
```

Replace `vX.Y.Z` with a release tag from [the tags list](https://github.com/evolving-edge/ee-cdn-cli/tags). Referring to `@main` instead means every change to this repository changes your deploys the moment it lands. For the same reason, set `builder-version` so a new ee-builder release can't change what a re-run uploads.

Every input is described in `action.yml`; they match the CLI's flags. The ones that differ from the CLI:

- **`working-directory`**: where the project is, when it isn't at the root of the repository. Output-folder detection and relative paths start there.
- **`dry-run: true`**: packages the site without uploading it, and needs no token. Use it to test a workflow before giving it a deploy token.
- **`image-hosts`**: the CLI's repeatable `--image-host`, as one input separated by spaces, commas or new lines.
- **`image-max-width`**: the CLI's `--image-max-width`. It changes the image files that are deployed (see "Resizing images"); leave it empty to change nothing.
- **`level`**: 0 or 2. Level 1 is refused, because its key is made for each build and must reach only the browser; a CI run has no safe place to give it to you.
- **`url`** (output): `https://<domain>`, once the upload is accepted. Empty on a dry run.

**Node.** If the runner's Node is 22.12 or later, the action uses it and changes nothing. Otherwise it installs Node 22.12 with `actions/setup-node`, and that Node stays first on `PATH` for the rest of the job. If a later step needs a different Node, set it up after this action.

The action packages and uploads only. It runs no other build tool: build the site, including any CSS step such as Tailwind, in the steps before it.

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
ee-builder -src dist -out /tmp/check.ee | grep 'Content hash'    # must equal the logged "Content hash"
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
| `deploy.trailingSlash` | boolean | `true` | Writes `# ee:trailing-slash on` into `dist/_redirects`, so a bare `/about` redirects to `/about/` instead of 404ing. Set `false` to leave `_redirects` alone. |
| `deploy.images` | `'webp' \| 'avif' \| 'off'` | — | Convert the site's JPEG and PNG images while packaging; see "Image conversion". Unset, `ee.jsonc` decides. |
| `deploy.imageHosts` | string[] | `[]` | Other hosts the site is served from; `deploy.domain` always counts. |
| `deploy.imageReport` | string | — | Write the conversion report as JSON here, relative to the project root. |
| `deploy.imageMaxWidth` | number | — | Scale JPEG and PNG images wider than this down to it before packaging; see "Resizing images". Changes the deployed image files. |
| `controlPlane` | string | `https://cp.3dge.app` | |
| `token` | string | `$EE_CDN_TOKEN` | |
| `builderPath` | string | — | Use a local `ee-builder` instead of downloading. |
| `builderVersion` | string | `latest` | Pin a published ee-builder version; see "Pin ee-builder in CI". |
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

The first download's digest is recorded in `.ee-builder-lock.json` and every later download must match it. **Commit that lockfile** so CI verifies the same binary you built against. Pass `builderChecksum` to pin a digest explicitly instead. A pin always wins.

The control plane also publishes a `.sha256` beside each ee-builder binary. A fresh download must match it. For `latest`, which moves, it is fetched on every run: a cached copy that no longer matches is stale and is downloaded again, unless the lockfile pins it, in which case the pinned copy is kept and a warning names the newer release and the lockfile entry to delete to move to it. Without the network, or for a release published before the `.sha256` existed, the cache and the lockfile decide as before. The cache is shared by every project on the machine, so each binary is also kept under its digest: one project moving to a newer `latest` never removes the binary another project's lockfile pins.

Published targets are `linux/amd64`, `linux/arm64`, `darwin/arm64`,
`darwin/amd64` and `windows/amd64`. On anything else, build from source and
pass `builderPath`.

## Custom domains

`ee-domain` claims a hostname for a project and prints the two DNS records to add at your DNS provider. With `--wait`, it checks until the claim is active and the certificate is issued:

```sh
ee-domain claim blog.example.com --project proj_abc --wait
ee-domain status blog.example.com
ee-domain verify blog.example.com   # check the TXT record now
```

It reads `EE_CDN_TOKEN` and `EE_CDN_PROJECT_ID` like `ee-deploy`. Use a project-scoped deploy token, which manages its own project's domains, or an admin token. Global deploy tokens are refused.

## After a deploy

Propagation takes up to about 90 seconds: the control-plane alias cache is 60s,
the edge domain cache 30s, and the node heartbeat 30s.

Deploys are content-addressed and immutable, so rolling back is repointing an
alias — the previous bundle is still there.

## Known CDN limitations

These are properties of the CDN, not of this package:

- **Default cache headers.** HTML revalidates on every request
  (`max-age=0, must-revalidate`, with an ETag), files under `_astro/` (and a
  few other known build folders) are cached for a year as immutable, and
  everything else for an hour with `stale-while-revalidate`. Level 1 and 2
  sites are served `no-cache`. On Level 0 a `_headers` file can set your own
  `Cache-Control`, for example a year for your generator's hashed-asset
  folder; see [Response headers](https://docs.evolvingedge.ai/headers/) for
  per-generator rules.
- **One site-wide 404.** A miss serves your root `404.html` with a 404 status,
  or the platform's own 404 page if you have none. There are no per-directory
  404 pages.
- **The trailing-slash redirect is opt-in.** `/page` 404s where `/page/`
  works, unless `_redirects` contains `# ee:trailing-slash on`.
- **Clean URLs are opt-in.** A generator that writes `page.html` but links to
  `/page` (Quartz, Observable Framework, vite-ssg, VitePress with
  `cleanUrls`, and others) needs `# ee:clean-urls on` in `_redirects`, which
  serves `/page` from `page.html` without a redirect. Astro doesn't need it:
  it writes `page/index.html`.
- **Redirects are Level 0 only.** A Netlify-format `_redirects` file
  supports 301, 302, 200 (rewrite) and 404 rules. A Netlify-format `_headers`
  file sets response
  headers on Level 0 and Level 2 sites, not Level 1.
- **Static only.** No SSR, no adapters.
- **A custom domain needs a claim.** Its certificate is issued once the
  claim's DNS records are verified; see [Custom domains](#custom-domains).

## Releasing

Bump the version in a pull request. When it merges to `main`, CI publishes that version and stops. Any other merge is a no-op, because the workflow asks the registry whether the version in `package.json` is already there.

```bash
npm version minor --no-git-tag-version   # then commit, PR, merge
```

Publishing uses npm trusted publishing (OIDC) — there is no `NPM_TOKEN` anywhere.

**The first publish of a new package cannot use OIDC.** npm hangs trusted publishers off a package's settings page, and a package that has never been published does not have one, so OIDC can publish to a package but cannot create one. An owner of the `evolving-edge` npm org publishes once by hand (`npm login && npm publish`), adds the trusted publisher, and every release after that is automatic. `.github/workflows/publish.yml` carries the exact field values, and CI fails with those instructions in the job summary if it runs before the bootstrap is done.

## License

MIT
