# Tasks

## File panel keyboard navigation
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| FD-1 | Type-ahead search in the file panel: letters typed in quick succession jump to the first name with that prefix; the buffer resets after a short pause | done | claude-20261010-typeahead | typeahead-nav | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/41. CI green on 268c691; `web` tests 79/79 passing, typecheck clean. Not checked in a browser. |
| FD-2 | Release v0.3.4 so the type-ahead fix (FD-1) deploys | done | claude-20261010-typeahead | release-v034 | | | Superseded by FD-4: tag v0.3.4 pushed but Release run 37994192165 failed on Docker Hub, so no image was published. |
| FD-3 | Release workflow pulls from Docker Hub via mirror.gcr.io so hosted-runner rate limits and timeouts stop failing releases | done | claude-20261010-typeahead | release-v035 | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/43; v0.3.5 Release run 37995971381 succeeded through the mirror. |
| FD-4 | Release v0.3.5 so the type-ahead fix (FD-1) deploys | done | claude-20261010-typeahead | release-v035 | | | Release run 37995971381 succeeded; filedeck-hub and agents eu3, eu4, hq0, hq1 run ghcr.io/dynacomsolutions/filedeck:0.3.5, Argo app Synced Healthy. |
| FD-5 | Git column wide enough to show the branch name in folder git pills (was cut to one letter) | in_progress | claude-20261010-typeahead | git-pill-width | | 2026-10-10 06:30 ICT | GIT_COL_W 72 to 144, `.git-br` min-width 3ch, `td.git-td` clips |
| FD-6 | Release v0.3.6 so FD-5 deploys | in_progress | claude-20261010-typeahead | git-pill-width | FD-5 | 2026-10-10 06:30 ICT | Tag after merge; Argo image-updater picks up the semver tag |
