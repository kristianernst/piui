# piui

A local React/Vite web UI for [Pi](https://pi.dev), backed by Pi's native Node SDK.

## Feasibility summary

Pi is feasible as a web app **when the browser is paired with a local Node process**. The browser cannot safely access Pi tools, credentials, sessions, or the OS directly; this repo runs a local server that imports `@mariozechner/pi-coding-agent`, then streams Pi session events to React over WebSocket.

What works natively:

- Pi auth/model config from `~/.pi/agent`
- persistent Pi session files via `SessionManager.create(cwd)`
- real Pi SDK event stream: assistant deltas, thinking deltas, tool start/update/end, queue updates
- default Pi resource discovery for context files, skills, prompts, extensions, settings
- real OS tools from Pi (`read`, `bash`, `edit`, `write`, etc.) resolved against the selected cwd

The visual direction uses `chatui-reference/` as non-shipping reference material: centered chat column, quiet sidebars, reasoning blocks, tool pills, context/model footer, and compact workflow sidebars.

## Run

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:5174>. The server binds to localhost and the browser fetches a startup WebSocket token from `/api/health` before connecting.

By default the daemon registers this repo as the first workspace. Add more workspaces from the sidebar, or seed a different first workspace:

```bash
PIUI_CWD=/path/to/your/project npm run dev
```

Workspace registry is stored at `~/.pi/agent/piui-workspaces.json`.

## SQL analytics demo

This repo includes a project-local Pi extension at `.pi/extensions/sql-analytics/` that registers:

- `db_describe` — inspect read-only database schemas and columns.
- `db_query` — run bounded read-only `SELECT`/`WITH` SQL.
- `db_visualize` — run read-only aggregate SQL and return chart-ready rows.

The extension defaults to the medicine supply-chain demo database:

```text
postgresql://medicine_agent_ro:medicine_agent_ro_password@localhost:55432/medicine_supply_chain_demo
```

To seed the demo database:

```bash
cd /Users/kristianernst/work/datasets/medicine_supply_chain_seed_package
docker compose up -d
```

Override the connection with either `PIUI_ANALYTICS_DB_DSN` or `ANALYSIS_DB_MEDICINE_DSN` before starting `piui`.

## Scripts

- `npm run dev` — local server + Vite middleware
- `npm run build` — Vite client build + TypeScript server build
- `npm run start` — serve production build
- `npm run typecheck` — client and server type checks

## Architecture

```
React/Vite UI  <-- WebSocket /ws -->  local piui daemon  -->  Pi SDK runtimes  -->  local OS
```

Current daemon capabilities:

- multi-workspace registry
- per-browser-connection Pi runtime creation guarded by session-file locks
- open/switch workspace
- list/switch saved Pi sessions
- advisory session-file locking with per-session atomic lock files
- new session / continue recent / fork / clone / compact / export
- prompt, abort, explicit steer/follow-up queues, model selection/cycling, thinking level changes
- resource snapshots for commands, tools, skills, prompts, and context files
- browser fallback for extension UI select/confirm/input/editor/status requests
- streaming assistant/tool events

See `docs/feasibility.md` for the Pi docs reviewed and next implementation steps.
