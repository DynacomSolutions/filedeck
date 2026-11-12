# Browser acceptance checks

These checks drive the built Filedeck web app in Chromium with Playwright against a deterministic fake API. They run in CI on every change under `web/` (the `browser` job in `.github/workflows/ci.yml`) and never call a live Filedeck API: the script intercepts every `/api/**` request in the browser and answers it from fixtures in `acceptance.mjs`, so the server only has to serve the built static files.

There is one run, no scopes. It makes these checks, in order (the names are what the output prints):

- File list: grid semantics (selected and current row, `aria-activedescendant`, file or folder in the row name); focus returns to the list after Shift+F10 then Escape, after a rename (committed and cancelled) and after creating a folder; the row context menu scrolls and every item is reachable at 1366x768, and a submenu opens inside the window.
- Keyboard: the shortcuts dialog (focus trap, focus back on its opener, URL history); Properties keys do not act on files; Tab from one panel reaches the next panel's toolbar with two and with three panels, and Alt+PageDown / Alt+PageUp switch panels; the Trash grid selects one item with Space and moves with the arrows; tooltips (hover, focus, Escape).
- Workflows: Properties tabs and chmod, no Git tab outside a repository, worktrees and the pull request diff inside the Git section, URL history and direct links (Settings, Trash, Git section), folder history, archive preview and folder-sync routes, presentation settings (32 px text without clipping, persistence, reset), copy and move to another node, saved-password renewal.
- Large and short views: a 20,000-entry listing keeps the DOM small and End and Home reach its ends; at 844x390 at least five rows are fully visible; text typed in the editor survives the window crossing the panel-width and phone thresholds.
- Address bar and Compare toolbar: every address-bar control is 44 px tall, at least 24 px wide and does not overlap another at 1365, 390 and 320 px; focusing "Edit address" with Tab does not start editing, Enter and Space do; no Compare toolbar button is clipped by its panel at 1365, 1280, 1024, 390 and 320 px; on a phone the Compare toolbar collapses to Filter, Compare by, the primary action and a More menu (at most 100 px tall, at least 8 of 40 compared rows visible at 390x844, menus reachable by keyboard and returning focus to their button).
- Layout: no horizontal document overflow at 1440x900, 1024x768, 768x1024, 390x844, 320x568, 844x390 and 320x256.
- axe-core with the WCAG 2.0, 2.1 and 2.2 A and AA rule tags (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`) on the main view, an open context menu, an open dialog, Settings, the Trash view, the Compare view, the Markdown preview and the phone layout, each in light and dark.
- Measurements at 1365, 390 and 320 CSS pixels in light and dark: axe-core A and AA again, controls clipped by a container that cannot scroll, text-spacing overrides (WCAG 1.4.12), visible and unobscured focus, and document overflow.

The measurements also report, without failing, what the product does not claim: AAA rules from axe-core (7:1 contrast, for example) and every target smaller than 44 CSS pixels (2.5.5). They appear as `advisory` lines in the output.

A check that has found a defect the component's owner has not yet fixed is listed in the script (`expectKnownDefect`, `knownAxe`) and printed as "Known defects still present". Such a check keeps running: when the defect is fixed the run fails until the entry is removed, so the list cannot go stale.

## Running it locally

From this directory install the test dependencies and a Chromium once:

```sh
npm ci
npx playwright install chromium
```

Serve a built app (`npm run build` at the repository root, then start the hub with `FILEDECK_MODE=hub FILEDECK_STATIC=<repository>/web/dist PORT=<port> node server/dist/main.js`; no agent is needed) and point the script at that origin:

```sh
FILEDECK_URL=http://127.0.0.1:<port> npm run check
```

- `FILEDECK_URL` is required; the script contains no deployment or machine-specific address.
- `CHROMIUM_PATH` selects a system Chromium instead of the Playwright download.
- `FILEDECK_EVIDENCE_DIR` is where screenshots and reports go (default `./evidence`, ignored by git). Each measurement run writes a screenshot and a JSON report there, and a failed check writes the last screenshot of each of its pages as `fail-<check>-<n>.png`. CI uploads the folder as the `browser-acceptance-evidence` artifact when the job fails.
- `FILEDECK_ONLY` runs only the checks whose name contains one of the comma-separated words, for example `FILEDECK_ONLY="focus returns,Trash"`. It is a debugging aid; CI runs everything.

The run takes two to three minutes.
