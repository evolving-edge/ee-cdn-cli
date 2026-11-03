---
"@evolving-edge/ee-cdn-cli": minor
---

Sites up to 1 GiB, and redeploys that don't upload again.

- **1 GiB limit:** the CLI now reads the package limit from the control plane (`/api/limits`) instead of assuming 100 MiB, and still stops before uploading a package that is over it. With a control plane that predates the endpoint it assumes 1 GiB. Uploads stream the package from disk instead of reading it into memory.
- **Redeploys and rollbacks without an upload:** when the content is already stored at the same level for your project, `ee-deploy` deploys what is stored instead of uploading it again. That fixes redeploying or rolling back a Level 1 or Level 2 site, which used to fail with `409`. At Level 1 it needs the key that opens what is stored: `--key` or `EE_CDN_LEVEL1_KEY` for `ee-deploy`, and the Astro integration's key cache, which now saves a build's key before uploading so a lost response loses no key. A control plane that predates the change gets the upload as before.
- **ee-builder:** packaging writes to disk as it builds, so memory no longer grows with the site (about 0.75 GB for a 1 GiB site). That comes with the ee-builder published 2026-11-03; a cached `latest` is replaced automatically.
