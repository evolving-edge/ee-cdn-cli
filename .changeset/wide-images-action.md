---
"@evolving-edge/ee-cdn-cli": minor
---

New image options, and a GitHub Action.

- **Image conversion:** `--images webp|avif` converts a site's JPEG and PNG images while packaging and rewrites every reference to them. `--image-host` names other hosts the site is served from, and `--image-report` writes the conversion report as JSON. `--images off` overrides `ee.jsonc`. In the Astro integration: `deploy.images`, `deploy.imageHosts` and `deploy.imageReport`.
- **Scaling down wide images:** `--image-max-width <px>` scales JPEG and PNG images wider than `<px>` down to that width before packaging, keeping their names and formats. This changes the deployed image files, never your build output. In the Astro integration: `deploy.imageMaxWidth`.
- **GitHub Action:** this repository is now a GitHub Action (`uses: evolving-edge/ee-cdn-cli@v0.4.0`) that runs `ee-deploy` with its own Node, for sites built with Hugo, Jekyll, Zola and other tools that don't use Node. Its inputs match the CLI's options, including `images`, `image-hosts`, `image-report` and `image-max-width`. It deploys Level 0 and Level 2 sites; Level 1 is refused.
- **ee-builder checks:** before using an image option, the CLI checks that the ee-builder it runs has the flag, and stops with a message saying what to do if it doesn't. A cached `latest` ee-builder is compared with the checksum published beside it and replaced when a newer one is out. A version pinned in your lockfile is kept.

Image options need a recent ee-builder: conversion is in builds published since 2026-10-23, and `--image-max-width` in builds published since 2026-10-24.
