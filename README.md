# Webcard site

A one-page bookmark gallery built with vanilla JavaScript and Vite. **Every card
is rendered into HTML at build time**, including its title, description, image,
and outbound link. It is not a SPA: search engines and visitors without JavaScript
receive the complete page. A small script only enhances the responsive grid into
a masonry-style layout.

Cards are portable [Webcard Format 1.0.0](https://github.com/reggi/webcard/blob/main/spec/1.0.0/README.md)
ZIP archives, committed to your repository. Builds read saved cards offline;
only an explicit capture/refresh contacts their websites.

## Create your own instance

1. Use this repository's **Use this template** button. Name it `USERNAME.github.io`
   for a root site, or any other name for a project site.
2. In **Settings → Pages**, select **GitHub Actions** as the build source.
3. Install the Node version in `.nvmrc` and run `npm ci`.
4. Run `npm run template:init` in your new repository. This removes the copied
   embedded template, resolves the pinned upstream release, and writes
   `.knitto.lock`. Commit the bootstrap changes. Do not run it in upstream
   `reggi/webcard-site`.
5. Edit `site.config.json` and `theme.css`, commit, and push. Run **Deploy static
   webcards** manually if an initial deployment has not started.
6. Run **Add webcard** from the Actions tab with a public website URL.

The default branch must permit bot commits. Protected-branch ingestion through
PRs is not included. Ordinary capture/deployment uses GitHub's built-in token
and Pages OIDC, not a personal access token.

The repository starts empty; it does not inherit the author's personal cards.
All URLs, metadata, screenshots, and archive history in a public repository are
public. Do not save private bookmarks here.

## Add and refresh URLs

```sh
gh workflow run add-webcard.yml -R OWNER/REPOSITORY \
  -f url=https://reggi.github.io/journal-calendar/

gh workflow run add-webcard.yml -R OWNER/REPOSITORY \
  -f url=https://reggi.github.io/journal-calendar/ -f refresh=true

gh workflow run deploy-pages.yml -R OWNER/REPOSITORY
```

In GitHub's UI, open **Actions → Add webcard → Run workflow** and enter the URL.
Use the default branch. A public URL alone cannot authenticate or trigger a
workflow; it is the dispatch input, not a public submission endpoint.

You can also use GitHub's
[`workflow_dispatch` REST endpoint](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
with your own authenticated client:

```sh
gh api --method POST repos/OWNER/REPOSITORY/actions/workflows/add-webcard.yml/dispatches \
  -f ref=main -f 'inputs[url]=https://reggi.github.io/webcard/'
```

The workflow generates a card, commits the validated archive/collection update,
and explicitly calls deployment. It does not rely on a bot-authored push
triggering another workflow. Cache hits still rebuild/deploy without an empty
commit. Failed captures never replace a saved card or deploy partial output.

GitHub concurrency serializes ingestion but is **not a durable submission queue**:
pending runs can be replaced by later runs. Check run status and retry canceled
dispatches; do not submit an unattended burst expecting every URL to be saved.
Deployment rejects stale builds and builds the latest default-branch state.
Rerun deployment if the branch advanced while a build was running.

## Local use

```sh
npm ci
npx playwright install chromium
npm run card:add -- https://reggi.github.io/webcard/
npm run card:add -- https://reggi.github.io/webcard/ --refresh
npm run dev
npm run build
npm run preview
```

Commit `cards/` after successful local additions. A build needs neither Chromium
nor network access to bookmarked sites. Dependency installation still requires
npm access.

Metadata capture prefers Open Graph, then Twitter, then HTML title/description,
with the hostname as a last-resort title/site name and an empty description if
absent. A usable preview image becomes WebP. Without one, a bounded
1200×900 Playwright screenshot becomes the image. Optional icons are saved when
usable; failures and fallbacks produce warnings. No AI service is involved.
Preview decoding accepts bounded raster images (JPEG, PNG, WebP, GIF, AVIF).
SVG previews use screenshot fallback rather than a filesystem-capable SVG
renderer; unsupported optional icons produce a warning.

Only public HTTP(S) destinations without URL credentials are permitted.
Redirects, image downloads, and browser HTTP subresources all pass through the
same DNS-bound network reader. Private, loopback, reserved, and link-local
destinations are blocked. Browser traffic is intercepted and fulfilled by that
reader; a dead proxy blocks unhandled traffic, WebSockets and service workers
are disabled, and only GET requests are allowed. Capture jobs do not receive
write/deploy tokens.

The source page must be accessible as HTML. Authentication, anti-bot walls, and
pages that cannot produce a valid bounded image fail explicitly rather than
creating fabricated previews.

## Cache, identity, and history

- `cards/<sha256>.webcard` is the persistent cache/source of truth, not an
  ephemeral GitHub Actions cache.
- The key hashes the WHATWG URL-serialized requested URL (including query and
  fragment). Standard host casing/default-port serialization applies; query
  strings are not stripped and canonical URLs never merge different sources.
- The submitted URL remains `sourceURL`; the observed page canonical URL is
  recorded separately in the capture.
- Cache hits validate the existing archive and perform no website fetch.
  Corrupt caches fail and require deliberate repair, not silent replacement.
- Refresh appends a dated capture only when display metadata/assets change.
  Unchanged refreshes update `lastRefreshedAt`. Previous capture bytes, assets,
  compatible unknown fields, and opaque extension entries are retained.
- `cards/collection.json` records identity and first-added time. Newest-added
  cards come first; refresh does not reorder them.
- Signed archives cannot be refreshed without a supported signature profile.

Do not manually rename archives or remove only one half of a collection entry.
To remove a card, delete its archive **and** its matching collection entry, commit,
and rebuild. Unregistered/missing archives fail validation. A local
`cards/.capture-lock` prevents concurrent writers; if a process was interrupted,
inspect pending changes before removing that specific lock directory.

## Configuration and themes

`site.config.json` and `theme.css` are yours. Template updates never overwrite
them or `cards/`.

```json
{
  "title": "My webcards",
  "description": "Places worth keeping.",
  "language": "en",
  "siteURL": "https://USERNAME.github.io/",
  "base": "/",
  "theme": "system"
}
```

`theme` is `system`, `light`, or `dark`. An empty `siteURL`/`base` uses the Pages
configuration supplied by Actions; local development defaults to `/`.
For project sites use `https://USERNAME.github.io/REPOSITORY/` and `/REPOSITORY/`.
For a custom domain set the explicit URL; its path determines the base when
`base` is empty. When both are provided, their paths must agree.

The page includes description/Open Graph metadata and CollectionPage/ItemList
JSON-LD. A configured site URL adds a canonical link, `robots.txt`, and a
one-page sitemap. Preview images are local static assets, not third-party image
requests when visitors open the gallery.

Override variables in `theme.css`, for example:

```css
:root {
  --background: #fdf6e3;
  --surface: #fffdf5;
  --text: #27231b;
  --muted: #625a48;
  --accent: #8b4513;
  --font-family: Georgia, serif;
  --card-min-width: 18rem;
  --grid-gap: 1.5rem;
  --card-radius: .5rem;
}
```

Other variables include `--border`. Ensure sufficient color contrast when
customizing. JavaScript-disabled pages use a normal responsive grid with the
same card order/content; no hidden app mount or loading placeholder is needed.

## Template upgrades and rollback

Upstream maintains generator code, tooling, tests, and workflows using
[Knitto](https://github.com/reggi/knitto). Your repository pins an immutable
release tag in `.knitto.json` and its snapshot digest in `.knitto.lock`.
Package `name`, `description`, and other unmanaged metadata remain yours.
README is initialized only if missing.

Enable **Settings → Actions → General → Allow GitHub Actions to create and
approve pull requests** before running **Update webcard template** with a
published tag such as `v0.1.4`. The workflow validates the new code and browser
behavior before opening an update PR. GitHub-token-authored PRs do not
automatically trigger other workflows, which is why validation runs explicitly
before PR creation.

Locally:

```sh
npx --no-install knitto source pin . --ref v0.1.4
npx --no-install knitto plan . --update
npx --no-install knitto apply . --update
npm install --package-lock-only
npm ci
npm run check
npm run test:browser
```

Review and commit the changes; revert the update commit to restore the prior
source/lock/managed files. A later explicit update can then reapply them.
Do not retain `.knitto/` in consumers: embedded templates override remote
sources and would otherwise hide upstream updates.

Template authors run `npm run template:manifest` after changing managed files
or the package version. The generated manifest's release version must match the
immutable release tag. Commit the generated package asset/manifest, create a
`vX.Y.Z` tag, and publish a GitHub release. Consumer refs should advance only
through reviewed changes.

## Validation and format profile

```sh
npm run check
npx playwright install chromium
npm run test:browser
npm run template:test
```

Archive schemas are vendored from the immutable Webcard 1.0.0 specification.
The reader additionally checks ZIP structure/CRC, first `mimetype`, paths,
duplicate members, Unicode, chronological timestamps, all capture references,
WebP decoding, and SHA-256 digests/lengths. Unsupported versions, compressed
entries, encryption, directory/link entries, and unknown core files are rejected.
Extensions are preserved without interpretation.

Implementation limits: 64 MiB archive/expanded size, 1,000 entries,
256 KiB per metadata document, 10 MiB per entry/image, 20 million decoded
pixels, 100 captures per card, and 1,000 collection cards. HTTP HTML is limited
to 2 MiB; downloads to 10 MiB; redirects to five; each fetch to 30 seconds.
Browser capture has a 30-second network budget, at most 100 requests/50 MiB
aggregate responses, and a fixed viewport (not a full-page capture).

There is no automatic history pruning, scheduled refresh, private-page login,
bulk queue, hosted backend, or archive-download UI in this initial version.
Binary history grows Git storage; monitor repository size and keep backups.
