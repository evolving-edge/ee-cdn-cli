---
"@evolving-edge/ee-cdn-cli": patch
---

New `ee-migrate` command: move a site's Netlify settings to Evolving Edge.

`ee-migrate [folder]` reads the folder's `netlify.toml` and writes the `_redirects` and `_headers` files Evolving Edge reads. It prints what was carried over, each setting it dropped with its line and the reason, and what is left for you to do, and writes the same report as JSON. A site that already has `_redirects` or `_headers` keeps its own rules; the translated ones are added after them, and running it again replaces what it added. Every rule is checked with the same validator a deploy uses, so what is written deploys.

- Exits 0 whenever the files and the report were written, even with settings dropped. `--strict` exits 1 when any setting was dropped; build settings and `[dev]` don't count.
- Runs ee-builder, downloaded and checked as `ee-deploy` does, without your deploy token. It needs the ee-builder published on 2026-11-10 or later; with an older one it stops and says how to get a newer one, without changing your `.ee-builder-lock.json`.

Run it with `npx --package=@evolving-edge/ee-cdn-cli ee-migrate ./my-site`. See "Moving from Netlify" in the README.
