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

## State & config

Piui keeps small app state in the Pi agent directory:

- `~/.pi/agent/piui-workspaces.json` — workspace registry.
- `~/.pi/agent/piui-settings.json` — durable user settings, including theme, sidebar visibility, sidebar width, default model, default reasoning, title model, and starter prompt preference.
- `~/.pi/agent/piui-navigation.json` — restore-only navigation state, including the active workspace/session, expanded workspace rows, expanded session lists, file-tree folders, and right-panel tab.

The browser should not be the source of truth for durable Piui state; it hydrates these files through the local daemon on startup.

## Extensions

Extensions are loaded by Pi from the standard discovery roots (`~/.pi/agent/extensions`, project-local `.pi/extensions/`, installed Pi packages, etc.) — `piui` does not host its own. The composer surfaces them two ways:

- **`/` autocomplete** in the composer textarea — quick fuzzy picker for extension commands, prompts, and built-ins.
- **Extension dock** above the composer — collapses to a single bar with the run's title, working message, and spinner; expands into a faithful viewer for whatever the extension paints into Pi's UI surface (`setHeader`, `setFooter`, `setWidget`).

The dock is a TUI viewer, not a piui-specific protocol. Extensions written for the Pi terminal Just Work — their `(tui, theme) => Component` factories are hosted by a synthetic TUI server-side, `Component.render(width)` is invoked on every `requestRender()`, and the resulting ANSI lines are streamed to the browser and rendered with a small SGR parser. So an extension like [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) — which paints its experiment status as a `setWidget("autoresearch", (tui, theme) => …)` factory — shows up in the dock unchanged.

Notes for extension authors:

- The shim provides a fixed render width (currently 100 cols). Read it from `tui.terminal.columns` if your component depends on viewport size.
- `Component.dispose()` is called when a slot is replaced or cleared, so clean up subscriptions there.
- Interactive overlays via `ctx.ui.custom(...)` are routed to a focused browser overlay. Keyboard input is forwarded back to the server-side component as terminal escape sequences.

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
- server-hosted extension widgets and focused overlays (`setHeader`, `setFooter`, `setWidget`, `ctx.ui.custom`)
- streaming assistant/tool events

See `docs/design.md` for the feasibility notes and SDK/runtime architecture rationale.
