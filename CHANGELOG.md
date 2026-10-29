# @evolving-edge/ee-cdn-cli

Versions from 0.3.0 onward are written by [Changesets](https://github.com/changesets/changesets) from the changeset each pull request carries. The two entries below predate that and were reconstructed from the commit history, so they are less detailed than later ones will be.

## 0.4.1

### Patch Changes

- 7f08ceb: ee-builder no longer receives your deploy token.
  
  The CLI downloads ee-builder at run time and used to start it with its whole environment, `EE_CDN_TOKEN` included, though ee-builder never needs it: the CLI does the upload. ee-builder now starts with only what it needs to run (`PATH`, `HOME`, temp, locale and the Windows system variables), so a deploy token or other credential in your environment or CI is no longer passed to it.
  
  This protects against accidental exposure, such as a builder that logs its environment. To control exactly which ee-builder runs in CI, pin it with `--builder-version` (`builder-version` in the GitHub Action) and commit `.ee-builder-lock.json`.
  
  No incident of this has occurred. This is a proactive security fix.

## 0.4.0

### Minor Changes

- 605f7f3: New image options, and a GitHub Action.
  
  - **Image conversion:** `--images webp|avif` converts a site's JPEG and PNG images while packaging and rewrites every reference to them. `--image-host` names other hosts the site is served from, and `--image-report` writes the conversion report as JSON. `--images off` overrides `ee.jsonc`. In the Astro integration: `deploy.images`, `deploy.imageHosts` and `deploy.imageReport`.
  - **Scaling down wide images:** `--image-max-width <px>` scales JPEG and PNG images wider than `<px>` down to that width before packaging, keeping their names and formats. This changes the deployed image files, never your build output. In the Astro integration: `deploy.imageMaxWidth`.
  - **GitHub Action:** this repository is now a GitHub Action (`uses: evolving-edge/ee-cdn-cli@v0.4.0`) that runs `ee-deploy` with its own Node, for sites built with Hugo, Jekyll, Zola and other tools that don't use Node. Its inputs match the CLI's options, including `images`, `image-hosts`, `image-report` and `image-max-width`. It deploys Level 0 and Level 2 sites; Level 1 is refused.
  - **ee-builder checks:** before using an image option, the CLI checks that the ee-builder it runs has the flag, and stops with a message saying what to do if it doesn't. A cached `latest` ee-builder is compared with the checksum published beside it and replaced when a newer one is out. A version pinned in your lockfile is kept.
  
  Image options need a recent ee-builder: conversion is in builds published since 2026-10-23, and `--image-max-width` in builds published since 2026-10-24.

## 0.3.1

### Patch Changes

- 4a752f4: The ee-domain command no longer says custom domains are admin-only.

## 0.3.0

### Minor Changes

- 3d7dc0f: Add the `ee-domain` command, output-folder detection and new routing flags.
  
  - **`ee-domain`:** claim a custom domain for a project, check its status and verify it from the command line. Run it with `npx -p @evolving-edge/ee-cdn-cli ee-domain …`, or by name once the package is installed.
  - **Output-folder detection:** `ee-deploy` finds the build folder of common static site generators when you don't name one.
  - **`--trailing-slash` and `--clean-urls`:** turn on the trailing-slash redirect, or serve `/page` from `page.html`, without editing `_redirects`.
  - **`--builder-version`:** pin the `ee-builder` version a deploy uses.
  - **Windows and Intel Macs** are supported.
  - **Symlinks** inside the site folder are followed. A link that points outside it stops the deploy.
  - **`.git`, `.hg`, `.svn`, `.DS_Store` and `Thumbs.db`** no longer count towards a site's content hash.
  - **`npx @evolving-edge/ee-cdn-cli …`** still runs `ee-deploy`, now that the package has two commands.

## 0.2.0

### Minor Changes

- Level 1 keys are no longer embedded in built HTML by default. A Level 1 key in the page body defeats the point of Level 1 — the key is supposed to travel in the URL fragment, which browsers never send to a server — so anything that archived or proxied the HTML captured the key with it. ([#5](https://github.com/evolving-edge/ee-cdn-cli/pull/5))

## 0.1.0

### Minor Changes

- First published release.
- Level 2 workloads genuinely use Level 2: the workload secret reaches the control plane as a header rather than in the query string, and a Level 2 key never reaches the built HTML. ([#1](https://github.com/evolving-edge/ee-cdn-cli/pull/1))
- Renamed from `cdn-cli` to `@evolving-edge/ee-cdn-cli`. ([#2](https://github.com/evolving-edge/ee-cdn-cli/pull/2))
