# Contributing

- Keep the core free of deployment-specific hostnames, logos, colours and link targets; use chart values or `FILEDECK_BRAND`. `npm run check:neutral` checks generic chart defaults. Publication history is reviewed separately when preparing a release.
- Colours, fonts and spacing come from the theme tokens in `theme.css` (`var(--fg)`, `var(--border)` ...), never literals. Navigation state (panels, folders, sort, selection, open viewers) lives in the URL, see `web/src/urlState.ts`.
- Every path that touches the filesystem goes through `paths.ts` (`resolveRead`, `resolveWrite`) and, for the actual open or change, `openChecked` or `pinParent`/`pinDir`. A new mutating route must be listed in `server/src/readonly.ts` so read-only volumes cover it.
- Add a test beside each change (`server/test/*.test.ts`, `node --test` with `tsx`). Web changes are checked in a browser at desktop and phone width, dark and light, and with the keyboard.
- **Every action is a real button**: icon plus label, the standard button style (flat, 6px radius), a `Tip` when icon-only. Never a text link, underlined text, or an `<a>` for an action. A download may be an `<a className="btn-a" role="button" download>` (it is styled as a button); a genuine navigation anchor must carry `data-nav` and should be rare. `server/test/buttonrule.test.ts` fails the build on a link-styled action.
- Small pull requests, one concern each.

See [docs/development.md](docs/development.md) to build and run Filedeck locally.
