# The GitHub Pages site

This folder is the public landing page for PromptFixer, published at https://osman19702.github.io/PromptFixer/: one page (`index.html`), one stylesheet, one script, the app icon and a screenshot. There is no framework, no build step and no external script, font or tracker, because the page belongs to an app whose headline claim is that nothing leaves your machine; the only off-site requests it makes are an optional check of the GitHub API for a newer release and the download links a visitor clicks.

It is deployed by `.github/workflows/pages.yml`, which runs on a push to `master` that touches `site/` and again whenever a release is published, so the page catches up with a new installer without anyone editing it.

`site/releases.json` is written at deploy time by `node scripts/site-releases.mjs` from the GitHub Releases API and is git-ignored; the page reads it for the download card and the release notes. Without it (a fresh checkout, a page opened from the file system) the download button falls back to the releases page on GitHub.

To preview it, serve this folder over HTTP rather than opening the file, since a page on `file://` cannot read `releases.json`: for example `python -m http.server 8000 --directory site`, then open http://localhost:8000/. The `releases.json` in a checkout is whatever the script last wrote, or a hand-written fixture in the same shape; the deploy always regenerates it.
