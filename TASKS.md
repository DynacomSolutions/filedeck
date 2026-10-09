# Tasks

## File panel keyboard navigation
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| FD-1 | Type-ahead search in the file panel: letters typed in quick succession jump to the first name with that prefix; the buffer resets after a short pause | done | claude-20261010-typeahead | typeahead-nav | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/41. CI green on 268c691; `web` tests 79/79 passing, typecheck clean. Not checked in a browser. |
| FD-2 | Release v0.3.4 so the type-ahead fix (FD-1) deploys | blocked | claude-20261010-typeahead | release-v034 | FD-3 | | Tag v0.3.4 pushed, but Release run 37994192165 failed on Docker Hub; superseded by FD-4. |
| FD-3 | Release workflow pulls from Docker Hub via mirror.gcr.io so hosted-runner rate limits and timeouts stop failing releases | in_progress | claude-20261010-typeahead | release-v035 | | 2026-10-10 06:00 ICT | v0.3.4 Release run 37994192165 failed 4 times on Docker Hub (429, then auth.docker.io timeouts) |
| FD-4 | Release v0.3.5 so the type-ahead fix (FD-1) deploys | in_progress | claude-20261010-typeahead | release-v035 | FD-3 | 2026-10-10 06:00 ICT | Replaces the failed v0.3.4 release; the `v0.3.4` tag has no published image |
