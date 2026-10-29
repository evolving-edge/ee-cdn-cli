---
"@evolving-edge/ee-cdn-cli": patch
---

ee-builder no longer receives your deploy token.

The CLI downloads ee-builder at run time and used to start it with its whole environment, `EE_CDN_TOKEN` included, though ee-builder never needs it: the CLI does the upload. ee-builder now starts with only what it needs to run (`PATH`, `HOME`, temp, locale and the Windows system variables), so a deploy token or other credential in your environment or CI is no longer passed to it.

This protects against accidental exposure, such as a builder that logs its environment. To control exactly which ee-builder runs in CI, pin it with `--builder-version` (`builder-version` in the GitHub Action) and commit `.ee-builder-lock.json`.

No incident of this has occurred. This is a proactive security fix.
