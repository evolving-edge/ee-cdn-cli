---
'@evolving-edge/ee-cdn-cli': minor
---

A redeploy now uploads only what changed.

When you deploy a Level 0 site to a domain that already serves a package, `ee-deploy` and the Astro integration ask the control plane which parts of the new package it already holds, and send only the rest. A site with large files that mostly stay the same, such as a photo blog, now uploads about as much as you changed.

- **Nothing to set up.** It happens by itself when it can.
- **It can only fall back.** If the control plane has nothing to reuse, or anything goes wrong, the whole package is uploaded as before.
- **Level 1 and Level 2 sites** upload whole packages, as before: each build is encrypted with a new key, so nothing matches the previous one.
- **The first deploy after this release** uploads the whole package once, because the package layout changed.
