---
"@evolving-edge/ee-cdn-cli": minor
---

Add the `ee-domain` command, output-folder detection and new routing flags.

- **`ee-domain`:** claim a custom domain for a project, check its status and verify it from the command line. Run it with `npx -p @evolving-edge/ee-cdn-cli ee-domain …`, or by name once the package is installed.
- **Output-folder detection:** `ee-deploy` finds the build folder of common static site generators when you don't name one.
- **`--trailing-slash` and `--clean-urls`:** turn on the trailing-slash redirect, or serve `/page` from `page.html`, without editing `_redirects`.
- **`--builder-version`:** pin the `ee-builder` version a deploy uses.
- **Windows and Intel Macs** are supported.
- **Symlinks** inside the site folder are followed. A link that points outside it stops the deploy.
- **`.git`, `.hg`, `.svn`, `.DS_Store` and `Thumbs.db`** no longer count towards a site's content hash.
- **`npx @evolving-edge/ee-cdn-cli …`** still runs `ee-deploy`, now that the package has two commands.
