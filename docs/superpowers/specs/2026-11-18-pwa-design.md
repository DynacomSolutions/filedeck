# Installable app (PWA)

## Intent

Filedeck should install as an app: the proper icon on an Android home screen and a desktop launcher, a window of its own, a clear
screen when the hub cannot be reached, a prompt when a new version is deployed, and a notification when a long job ends while the
app is in the background. Asked for by the owner: "a PWA for this app with the proper icon on the android home, notifications, etc."

## Goals

- Installable in Chromium browsers (Android and desktop) with no installability errors; adds to the home screen in Safari.
- The icon is the existing Filedeck mark (`favicon.svg`), never a new logo, and is not clipped by Android's adaptive mask.
- The app opens without a network; with the hub not reachable it says so and retries.
- A deployed update is never used silently half-way: the page offers "Reload" and reloads only when asked.
- A job that ends while the app is hidden can notify, once the user switched notifications on in Settings.

## Non-goals and anti-goals

- No API answer, file content, listing, thumbnail or anything under `/api/` is ever stored by the service worker. They carry the
  signed-in account's data (sign-in, v0.4.0). A cached API answer shown to the next account would be a failure even if the app works.
- No permission prompt on page load. Notification permission is asked only from the Settings switch.
- No offline file work. Offline means the shell and a clear "hub not reachable" state, nothing more.
- No silent reload: a tab with unsaved editor text keeps it until the user chooses to reload (the existing leave-page guard applies).

## Approaches considered

1. **Hand-written service worker, bundled by a small Vite plugin (chosen).** `web/src/sw.ts` is emitted as `/sw.js`; the plugin
   writes the build's precache list and version into it. The request policy lives in `web/src/swPolicy.ts`, a pure module the unit
   tests import. About 150 lines, no new dependency, and the rule "never `/api/`" is one line that a test pins.
2. **vite-plugin-pwa / Workbox.** Less code to write, but adds a large dependency tree, generates its own runtime routing that has to
   be configured away from `/api/`, and its update and registration helpers would replace the app's own prompt. Rejected: more
   surface to audit for a rule that must never break.
3. **No service worker, manifest only.** Installable in some browsers, but no offline shell, no update prompt and no notifications on
   Android (Chrome on Android shows notifications only through a service worker). Rejected.

## Design

### Manifest and icons

- `/site.webmanifest` stays a static file in `web/public` with `id`, `name`, `short_name`, `description`, `start_url: "/"`,
  `scope: "/"`, `display: "standalone"`, `categories: ["productivity", "utilities"]`, `theme_color` and `background_color`.
- The hub serves it rendered with the deployment's brand (`FILEDECK_BRAND` name and title replace "Filedeck"), like `index.html`.
- A manifest has one colour of each kind. It carries the dark theme (the default): `theme_color` `#151518` (the header),
  `background_color` `#0c0c0e` (the page). `index.html` adds `<meta name="theme-color">` for light (`#ffffff`) and dark by
  `prefers-color-scheme`, and the page updates it when the user picks a theme in the app, so the title bar always matches.
- Icons are generated from `favicon.svg` by `web/scripts/icons.mjs` (uses `rsvg-convert`; the PNGs are committed, so a build needs no
  tool). Mark in light ink (`#e8eaed`) on the dark header colour, the same pair the dark favicon uses:
  - `icon-192.png`, `icon-512.png` (purpose `any`): mark at about 70 % on a rounded square.
  - `icon-maskable-192.png`, `icon-maskable-512.png` (purpose `maskable`): full-bleed background, mark inside the central 60 %
    (the safe zone is the central 80 % circle).
  - `icon-monochrome.png` (purpose `monochrome`, 512): the mark in white on transparent, for Android themed icons.
  - `apple-touch-icon.png` (180, full-bleed, iOS rounds it), `favicon-16/32/48.png` re-made from the same source.
- The result is checked visually, the maskable icon also through a circle crop.

### Service worker

- Registered from `main.tsx` in production builds only, scope `/`.
- Precache (cache `filedeck-<version>`): the entry script, its static imports and CSS, `theme.css`, fonts, icons, manifest. The
  version is a hash of the precache list (hashed file names), so every build changes `sw.js`.
- Fetch policy (`swPolicy.ts`):
  - Not GET, another origin, `/api/` or any path under it, `/sw.js`: not handled at all (no `respondWith`), the browser fetches.
  - Navigations: network first; a 200 HTML answer is stored as the shell (`/`, the hub renders it with only the brand, never
    per-account data); offline, the stored shell is answered.
  - Hashed `/assets/` files: cache first (they never change), stored on first use, so a chunk opened once (the editor) works
    offline later.
  - Other same-origin static files: cache first from the precache, else network.
- On activate, caches of older versions are removed. `skipWaiting` only when the page asks.
- The hub sends `/sw.js` and `/site.webmanifest` with `Cache-Control: no-cache`.

### Hub not reachable

- `main.tsx` asks `/api/auth/me` first. A network failure (fetch rejects) now shows a "Hub not reachable" screen in place of the
  app: the brand mark, one line of explanation, "Try again", and an automatic retry when the browser goes online and every 15 s.
  A hub answer that is an error (5xx) keeps today's behaviour (the app shows, its requests report the error).

### Update prompt

- When a new service worker is installed and waiting, a banner (`role="status"`) says "A new version of Filedeck is ready." with
  "Reload". Reload posts `skip-waiting`; on `controllerchange` that tab reloads. Other tabs that did not ask see the banner
  "Filedeck was updated. Reload to use the new version." and reload only when clicked.
- The page checks for an update when it becomes visible and every 30 minutes.

### Notifications (local)

- Settings gains an "App" section: a switch "Notify me when a job ends while Filedeck is in the background", and "Install app".
- Turning the switch on calls `Notification.requestPermission()` (a user action). Denied: the switch stays off and the section says
  how to allow it in the browser. Unsupported: the switch is disabled with a line saying so. The choice is stored in this browser.
- The jobs tray already collects jobs that just ended (`justEnded`, from copy, move, compress, extract, sync, compare and uploads).
  When the switch is on, permission is granted and the page is hidden (`document.visibilityState`), each finished or failed job
  (not cancelled ones, the user did that) shows a notification: title "<job> finished" / "<job> failed", body the detail line,
  tag the job key (no duplicates), icon the app icon. Several at once fold into one "3 jobs ended".
- Shown through `registration.showNotification` (needed on Android), with `new Notification` as the fallback. Clicking it focuses
  the open Filedeck window (the service worker's `notificationclick`).
- Background tabs keep polling the job list (throttled by the browser), which is enough while the app is in the background but not
  closed.

### Install

- `beforeinstallprompt` is caught at start-up and kept; Settings shows "Install app" while it is available and the app is not
  already running standalone. `appinstalled` hides it. Browsers without the event (Safari, Firefox) show nothing.

### Share target and file handling: not built

Both would need a destination: a shared file must land in a folder on some machine, so the app would need a "save shared files to"
picker and a POST route the service worker answers and turns into an upload. That does not fit cleanly into this change; it can be
a follow-up task if wanted.

### Web Push (proposal, not built; needs the owner's confirmation)

To notify while the app is fully closed:

- Config: `FILEDECK_VAPID_PUBLIC_KEY`, `FILEDECK_VAPID_PRIVATE_KEY` (secret), `FILEDECK_VAPID_SUBJECT`. Off when unset.
- Hub stores subscriptions per account and session in the auth database (`push_subscriptions`: account, session id, endpoint,
  keys, created). `POST /api/push/subscribe`, `DELETE /api/push/subscribe`.
- When a hub-run job (ops queue) of that account ends, the hub sends a push with only the job title and outcome (no paths beyond
  the title, payload encrypted per RFC 8291).
- Subscriptions end when their session ends (sign-out, expiry, "End session") and when the account changes (epoch bump, deleted,
  renamed); the hub deletes them on 404/410 from the push service. With sign-in off there is one shared subscription list.
- Agent jobs that the hub does not run would need the hub to watch agents' job lists; part of that proposal.

## Tests

- Unit (`web/test`): `swPolicy` (never handles `/api/`, the API root, non-GET, other origins; strategies per path), the notification
  decision (hidden, setting, permission, outcome, folding), the settings normaliser, the update-banner state.
- Server: the manifest route uses the brand; `/sw.js` and the manifest are `no-cache`.
- Browser acceptance (Chromium and Firefox): manifest fields and icons load; Chromium reports no installability errors
  (`Page.getInstallabilityErrors`); the service worker controls the page; after the hub is unreachable the page reloads to the
  "Hub not reachable" screen; no cache entry is under `/api/` after API traffic; the Settings App section passes axe in light and
  dark; the switch asks permission only on click.
- Lighthouse 12 no longer has a PWA category; the installability check above replaces it.

## Left to the builder

Exact wording, layout of the Settings section and banner within the existing styles.
