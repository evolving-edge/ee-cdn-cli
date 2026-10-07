# @evolving-edge/ee-cdn-cli

Versions from 0.3.0 onward are written by [Changesets](https://github.com/changesets/changesets) from the changeset each pull request carries. The two entries below predate that and were reconstructed from the commit history, so they are less detailed than later ones will be.

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
