# Contract tests

The files in `server/test/contract/` test the agent protocol through HTTP only.
They run against any agent that speaks the protocol: the TS agent in this repository, or another one, for example the Rust agent.

## The helper

`server/test/contract/agent-under-test.ts` gives each test an `agentUnderTest({ root, env })`.
The result has `request(path, init)` (the same call as Hono's `app.request`, with the bearer token added when the agent has one), `anon(path, init)` (never a token), `listen()` (a loopback base URL), `close()`, `root` and `token`.
A test that must read the TS internals uses `raw`, and runs only in process (`inProcessOnly()`).
`fixtureRoot()` and `dropFixtureRoot()` make and remove the folder that the agent serves as `/`.
`contractTest` is `test`, and it skips a test when the agent cannot take the settings the test needs.

## Modes

Set `FILEDECK_CONTRACT_MODE`.

| Mode | What it does | Settings |
|---|---|---|
| `inprocess` (default) | Calls the Hono app of this repository in the test process. This is what `npm test` runs. | none |
| `spawn` | Starts one agent child process per `agentUnderTest` call, on `127.0.0.1` with a free port, and stops it at `close()`. Each call can have its own settings. | `FILEDECK_CONTRACT_SPAWN`: the command line of the agent. Default: the TS agent (`node --import tsx src/main.ts`). |
| `url` | Uses one agent that already runs. A test that needs its own settings is skipped, because one running agent cannot take them. | `FILEDECK_CONTRACT_AGENT_URL`, `FILEDECK_CONTRACT_AGENT_TOKEN` (empty when the agent has no token), `FILEDECK_CONTRACT_ROOT` (the folder the agent serves as `/`). |

In `spawn` mode the harness sets `FILEDECK_MODE=agent`, `FILEDECK_ROOT`, `FILEDECK_NODE`, `FILEDECK_HOST=127.0.0.1` and `PORT`, and adds the settings of the test (for example `FILEDECK_AGENT_TOKEN`, `FILEDECK_JOBS_FILE`, `FILEDECK_INDEX_DIR`).
The agent must answer `GET /healthz` with 200 when it is ready.
In `url` mode the harness empties `FILEDECK_CONTRACT_ROOT` before and after each test, so use a folder with nothing in it that you want to keep.

## Run them against another agent

```sh
cd server
# start the agent on its own, serving an empty folder, with a token
FILEDECK_CONTRACT_MODE=url \
FILEDECK_CONTRACT_AGENT_URL=http://127.0.0.1:8080 \
FILEDECK_CONTRACT_AGENT_TOKEN=secret \
FILEDECK_CONTRACT_ROOT=/path/the/agent/serves \
node --import tsx --test --test-concurrency=1 test/contract/*.test.ts

# or let the harness start the agent for each test
FILEDECK_CONTRACT_MODE=spawn FILEDECK_CONTRACT_SPAWN="/path/to/agent-binary" \
node --import tsx --test --test-concurrency=1 test/contract/*.test.ts
```

Use `--test-concurrency=1` for `url` mode, because the test files share the one folder.

## CI

- The `server` job runs the contract files in process, as part of `npm test`.
- The `contract` job runs them in `spawn` mode against a TS agent child process.

## Contract files

| File | Covers |
|---|---|
| `agent-auth.test.ts` | bearer token on the agent, `/healthz` open, hub supplies the token |
| `size-metrics.test.ts` | `/metrics` is open, other routes need the token |
| `size-jobs.test.ts` | size jobs, shared walks, entry cap, du request sharing |
| `du-totals.test.ts` | exact du totals for a big tree, cached answer after a restart, `/healthz` during a scan |

The tests of the other release 1 files in the Rust agent plan (`readonly`, `request-guard`, `job-rebuild`, `jobs-abandon`, `node-status`, `change-events*`, `size-store*`, `du-cli`, `du-auth`) read TS internals (the job store, the event bus, the size store) or need sign-in on.
They stay in `server/test/` for now.
Move a test into `contract/` when it needs HTTP only.
