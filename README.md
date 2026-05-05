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

The visual direction references `/Users/kristianernst/Downloads/chatui-2`: centered chat column, quiet sidebars, reasoning blocks, tool pills, context/model footer.

## Run

```bash
npm install
npm run dev
```

Open <http://localhost:5174>.

By default Pi runs against this repo as cwd. To point Pi at another project:

```bash
PIUI_CWD=/path/to/your/project npm run dev
```

## Scripts

- `npm run dev` — local server + Vite middleware
- `npm run build` — Vite client build + TypeScript server build
- `npm run start` — serve production build
- `npm run typecheck` — client and server type checks

## Architecture

```
React/Vite UI  <-- WebSocket /ws -->  Node server  -->  Pi SDK  -->  local OS
```

See `docs/feasibility.md` for the Pi docs reviewed and next implementation steps.
