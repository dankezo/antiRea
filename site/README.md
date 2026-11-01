# antiRea documentation site

VitePress site for the docs in [`../docs/`](../docs/).

## Why this shape

- **Single source of truth.** The VitePress config sets `srcDir: '../docs'`,
  so pages render in place from the canonical Markdown. Nothing is copied
  into `site/`; editing a file in `docs/` updates both GitHub and the site.
  The only added document is `docs/index.md`, the landing page.
- **Isolated tooling.** VitePress is a devDependency of this private package
  only. The published `@dannyphan190/anti-rea` package keeps zero runtime
  dependencies, and `npm run check` at the repo root is unaffected.
- **GitHub-first links keep working.** Some docs link outside the site
  source (for example `../benchmark/rea/README.md` or `evidence/*.json`).
  Those links are correct on GitHub, so the config sets
  `ignoreDeadLinks: true` instead of rewriting canonical docs for the site.

## Develop and build

```sh
cd site
npm install
npm run docs:dev     # local preview
npm run docs:build   # outputs site/.vitepress/dist
```

## Publishing

`.github/workflows/docs.yml` builds the site on every docs/site change.
The deploy job runs **only** on manual `workflow_dispatch`, and only works
once GitHub Pages is enabled for the repo (Settings, Pages, source:
GitHub Actions). Until then the build job is the CI signal; do not wire
deploy to push, it would fail while Pages is off.
