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
- per-workspace Pi runtime creation
- open/switch workspace
- list/switch saved Pi sessions
- advisory session-file locking with multi-tab ref counting
- new session / continue recent / fork / clone / compact / export
- prompt, abort, explicit steer/follow-up queues, model selection/cycling, thinking level changes
- resource snapshots for commands, tools, skills, prompts, and context files
- browser fallback for extension UI select/confirm/input/editor/status requests
- streaming assistant/tool events

See `docs/feasibility.md` for the Pi docs reviewed and next implementation steps.
