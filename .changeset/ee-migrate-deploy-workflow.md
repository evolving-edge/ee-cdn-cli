---
"@evolving-edge/ee-cdn-cli": minor
---

`ee-migrate` now also writes a GitHub Actions workflow that builds and deploys the site on every push.

From `netlify.toml`'s build settings it writes `.github/workflows/ee-deploy.yml` at the root of the git repository. The workflow builds the site the way Netlify did for production deploys and deploys it with `evolving-edge/deploy-action`.

- **Toolchains:** Node, at the version the site names, and Hugo are set up. Any other tool the build uses is named in the summary and marked in the workflow for you to add.
- **Domain, project and token:** read from the repository variables `EE_CDN_DOMAIN` and `EE_CDN_PROJECT_ID` and the secret `EE_CDN_TOKEN`. The summary prints the `gh` commands that create them.
- **Build variables:** a variable that looks like a credential is read from a repository secret, given only to the install and build steps. The summary says to rotate it, since it's committed in `netlify.toml`. Values are never printed.
- **Your file is safe:** a workflow ee-migrate didn't write, wrote for another site, or that you've edited since is never replaced. The run stops before writing anything.

New options:

- `--no-workflow`: don't write the workflow.
- `--workflow <path>`: write it somewhere else.
- `--domain` and `--project`: write these values into the workflow instead of reading repository variables.
- `--secret <NAME>` and `--plain <NAME>`: decide how one build variable is handled. Both are repeatable.

The workflow needs an ee-builder with the deploy workflow. With an older one, `ee-migrate` says no workflow is written and does the rest as before.
