# Browser accessibility regressions

This optional Chromium check exercises the real Filedeck UI with a deterministic fake API. It covers keyboard-operable Properties tabs and context menus, modal focus trapping and restoration, tooltip keyboard/pointer dismissal, 44 CSS-pixel targets, axe serious/critical findings, text spacing, and narrow viewport reflow. It never calls a live Filedeck API.

From this directory, install the small test dependencies and a Chromium browser once:

```sh
npm install
npx playwright install chromium
```

Start a built Filedeck web app locally, then point the script at that origin. The test intercepts `/api/**` requests in Chromium and supplies its own deterministic fixture responses, so it does not need a connected node or a live API:

```sh
FILEDECK_URL=http://127.0.0.1:<local-hub-port> npm run check
```

If system Chromium is already installed, set `CHROMIUM_PATH` to its executable and skip the Playwright browser download. The server must serve the built SPA after applying its normal HTML boot/title substitutions. `FILEDECK_URL` is required; the script contains no deployment or machine-specific address. Set `FILEDECK_EVIDENCE_DIR` to choose a directory for screenshots; the default run creates no evidence files.
