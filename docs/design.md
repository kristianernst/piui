The clean architecture is: **React/Vite is only the client; a local Node backend owns Pi**. Do not try to run the Pi coding agent directly in the browser. The browser cannot safely or correctly own filesystem access, shell execution, `~/.pi/agent` credentials, session JSONL files, extensions, skills, prompt templates, or the project working directory.

Pi already has the right primitives for this. The docs explicitly support building a custom UI via the SDK, and the SDK exposes `AgentSession`, events, tools, settings, sessions, and runtime control. RPC mode also exists for headless stdin/stdout integration, but the docs recommend using `AgentSession` directly when building a Node/TypeScript app in the same process. ([Pi.dev][1])

My recommendation:

Use **React/Vite + local Node “Pi bridge” backend + Pi SDK**.

Conceptually:

```txt
Browser
  React/Vite UI
  state store
  WebSocket/SSE client
        │
        ▼
Local Node backend, bound to 127.0.0.1
  owns Pi runtime
  owns cwd/project selection
  owns sessions/settings/auth/tools
  streams Pi events to browser
        │
        ▼
@mariozechner/pi-coding-agent
  AgentSessionRuntime
  SessionManager
  SettingsManager
  DefaultResourceLoader
  AuthStorage
  ModelRegistry
        │
        ▼
Same Pi data used by terminal TUI
  ~/.pi/agent/settings.json
  ~/.pi/agent/auth.json
  ~/.pi/agent/sessions/
  project/.pi/settings.json
  project/.pi/extensions/
  project/.pi/prompts/
  AGENTS.md / CLAUDE.md
```

The important part is using **`AgentSessionRuntime`**, not just a bare `AgentSession`. A bare session is fine for simple “send prompt, stream answer” behavior, but the runtime layer is what Pi itself uses for interactive, print, and RPC modes, and it handles active-session replacement such as new sessions, switching sessions, forking, importing, and rebuilding cwd-bound state. ([Pi.dev][1])

A useful distinction:

A **session** is the persisted conversation state. Pi stores sessions as JSONL files, with each line being a typed JSON object, and the entries form a tree through `id` / `parentId`. That tree is what enables branching without needing a separate file for every branch. ([Pi.dev][2])

A **runtime** is the live in-memory owner of one active session. It knows the current project directory, loaded settings, extensions, tools, model, auth storage, compaction behavior, retry behavior, and the current event stream.

The **TUI** is just one interface over that runtime. Your Web UI should be another interface over the same runtime concepts.

Do not make `@mariozechner/pi-web-ui` the authoritative core if your goal is consistency with the Pi TUI. That package is useful, but its README describes reusable browser chat components backed by `pi-agent-core`, IndexedDB storage, browser API-key storage, and browser-side sessions. That is a different storage model from the coding-agent TUI, which uses `~/.pi/agent` and project `.pi` files. ([GitHub][3])

You can still use ideas or components from `@mariozechner/pi-web-ui`, but the source of truth should be the backend-owned `@mariozechner/pi-coding-agent` runtime.

For the project layout, I would use something like this:

```txt
pi-local-webui/
  package.json
  apps/
    web/
      React + Vite
    server/
      Node TypeScript backend
  packages/
    protocol/
      shared TypeScript message types
```

The backend should expose a small protocol to the frontend. Use WebSocket for bidirectional communication because the browser needs to send prompts, aborts, model changes, session switches, and extension UI replies while also receiving streaming events. Server-Sent Events is fine for pure streaming, but WebSocket is cleaner here because Pi has interactive flows.

The frontend sends commands such as:

```ts
type ClientCommand =
  | { type: "prompt"; text: string; images?: UploadedImage[] }
  | { type: "steer"; text: string; images?: UploadedImage[] }
  | { type: "follow_up"; text: string; images?: UploadedImage[] }
  | { type: "abort" }
  | { type: "new_session" }
  | { type: "switch_session"; sessionPath: string }
  | { type: "fork"; entryId: string }
  | { type: "clone" }
  | { type: "compact"; customInstructions?: string }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking_level"; level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" }
  | { type: "set_session_name"; name: string }
  | { type: "reload_resources" };
```

The backend sends:

```ts
type ServerMessage =
  | { type: "snapshot"; state: PiState; messages: AgentMessage[] }
  | { type: "event"; event: AgentSessionEvent }
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "models"; models: ModelSummary[] }
  | { type: "commands"; commands: SlashCommandSummary[] }
  | { type: "extension_ui_request"; request: ExtensionUiRequest }
  | { type: "error"; message: string };
```

On browser connect, the backend should immediately send a **snapshot**: current session state, current messages, current model, thinking level, current queues, session file path, token/cost stats if available, and loaded command metadata. Then it streams incremental Pi events. Pi’s event model already has the right pieces: message lifecycle events, streaming `message_update` events, tool execution start/update/end, queue updates, compaction events, retry events, and extension errors. ([Pi.dev][1])

For TUI consistency, use these rules.

First, the backend’s `cwd` must be the project directory. When you run `pi` in a terminal, Pi uses the current working directory as the project context. Your web backend should do the same. Starting the web UI from a project root should mean “open Pi for this project.”

Second, use the same Pi directories. Pi’s settings live globally at `~/.pi/agent/settings.json`, project settings live at `.pi/settings.json`, and project settings override global settings. ([Pi.dev][4]) Sessions auto-save under `~/.pi/agent/sessions/`, organized by working directory, unless a custom session directory is configured. ([Pi.dev][5])

Third, use the same resource discovery. Pi loads extensions, skills, prompts, themes, and context files through its resource loader. Extensions can live globally or project-locally, and they can register tools, commands, event handlers, custom renderers, and session-persistent state. ([Pi.dev][1]) The web backend should not invent a separate extension-loading system.

Fourth, do not use browser IndexedDB as the source of truth for Pi sessions. The browser can keep UI preferences, panel state, recently opened project paths, draft text, and layout settings. But the actual agent sessions should remain Pi JSONL session files.

Fifth, expose built-in TUI slash commands as web actions where possible rather than blindly sending every slash command as prompt text. For example, `/new`, `/resume`, `/tree`, `/fork`, `/clone`, `/compact`, `/model`, `/settings`, `/session`, `/export`, and `/reload` should become buttons, dialogs, menus, and panels. Extension commands, skills, and prompt templates can still be invoked as slash-command prompts because Pi exposes those through resource discovery and command handling. Pi’s interactive docs list the relevant built-in commands and session controls. ([Pi.dev][6])

Sixth, implement Pi’s queue semantics. In the TUI, submitting while the agent is running creates either a steering message or a follow-up message. Steering is delivered after the current assistant turn finishes tool calls; follow-up is delivered after the agent finishes its current work. ([Pi.dev][6]) In the UI, make this explicit: a send button when idle, and while streaming maybe two actions: “steer now” and “queue after completion.”

Concurrency is the main footgun. You should support moving between TUI and Web UI, but not two writers mutating the same live session file at once.

A good policy:

```txt
Web UI owns an active runtime while open.
TUI may resume the same session after Web UI closes.
Web UI may resume a session after TUI exits.
Multiple browser tabs may watch the same backend runtime.
Only one backend runtime may write to a given session file.
```

Implement an advisory lock per active session file. It can be simple: session path, PID, cwd, timestamp. If the Web UI detects another owner, open the session read-only or ask the user to switch to a clone/fork. Without this, you risk two runtimes appending to the same JSONL session in ways neither UI expects. The docs do not describe a multi-writer session model; they describe sessions as files managed by the active session/runtime. ([Pi.dev][2])

For authentication, do not send provider API keys to the browser. Let the backend use Pi’s normal `AuthStorage`. The SDK docs show the priority: runtime overrides, stored credentials in `auth.json`, environment variables, then fallback resolver. ([Pi.dev][1]) If credentials are missing, the Web UI can say “run `pi` and `/login` once” or you can later implement a local auth flow. But the browser should not own `~/.pi/agent/auth.json`.

For security, bind the backend to `127.0.0.1`, not `0.0.0.0`. Generate a random local token at startup and require it for WebSocket connections. Restrict accepted origins to the Vite dev origin and the production local origin. This matters because the Pi agent can read files, run bash, edit, and write through its tools. Pi’s built-in tool set includes filesystem and shell tools such as read, bash, edit, write, grep, find, and ls. ([Pi.dev][1])

The local launch command should feel like `pi`. For example:

```bash
pi-web
```

When run inside a project directory, that starts the backend with `cwd = process.cwd()`, starts or serves the React UI, and opens the browser. Later you can support:

```bash
pi-web -c
pi-web --session <path-or-id>
pi-web --fork <path-or-id>
pi-web --no-session
pi-web --readonly
```

Those should mirror the mental model of the Pi CLI, where `pi -c` continues the most recent session, `pi -r` resumes from a picker, `--session` selects a session, `--fork` forks, and `--no-session` disables persistence. ([Pi.dev][6])

The MVP should not try to clone the whole TUI. Build the durable core first:

```txt
MVP 1:
  local backend
  one active project cwd
  create/continue session
  prompt
  stream assistant text
  show tool calls and tool results
  abort
  show session file/model/thinking level

MVP 2:
  session picker
  new session
  switch session
  fork/clone
  compact
  set session name
  model selector
  thinking selector

MVP 3:
  command palette
  prompt templates
  skills
  extension commands
  queue UI: steer vs follow-up
  file/image attachments

MVP 4:
  extension UI bridge
  settings panel
  tree viewer
  export/share
  read-only session viewer
```

Extension UI deserves special handling. Extensions can ask the UI for selects, confirmations, inputs, editors, notifications, status, widgets, and similar interactions. RPC mode documents these as an `extension_ui_request` / `extension_ui_response` sub-protocol, and some TUI-only methods degrade or become no-ops outside the TUI. ([Pi.dev][7]) Even if you use the SDK, you should think in the same shape: translate extension UI requests into browser modals, notifications, status bar entries, or widgets. For custom TUI components, provide a fallback display rather than trying to render terminal components directly.

The architecture choice in one sentence:

Use **SDK runtime in a local Node backend** when you want a clean, typed, deeply integrated Web UI. Use **RPC child process mode** only if you specifically want process isolation or want to drive the globally installed `pi` binary as an external subprocess. RPC mode is valid and documented for custom UIs, but for Node/TypeScript the docs point you toward the SDK. ([Pi.dev][7])

I would avoid these designs:

```txt
Bad:
  React app imports pi-coding-agent directly
  Browser stores real Pi sessions in IndexedDB
  Browser stores provider API keys
  Web UI has separate settings from TUI
  Web UI creates a second custom session format
  TUI and Web UI write the same session file at the same time
  Web UI is just xterm.js embedding the TUI
```

The last option, `xterm.js` around `pi`, is viable only if you want a browser-hosted terminal. It would be consistent, but it would not give you a real new interface.

The clean target is a **Pi runtime adapter**:

```txt
PiRuntimeAdapter
  start(cwd, sessionTarget)
  dispose()

  getSnapshot()
  listSessions()
  switchSession(path)
  newSession()
  fork(entryId)
  clone()
  compact(instructions)

  prompt(text, images)
  steer(text, images)
  followUp(text, images)
  abort()

  getModels()
  setModel(provider, modelId)
  setThinkingLevel(level)

  listCommands()
  invokeCommand(name, args)
  reloadResources()

  subscribe(listener)
```

React should know almost nothing about Pi internals. It should know how to render messages, streaming deltas, tool executions, sessions, models, commands, and extension UI requests. The backend should know Pi. That separation will keep the Web UI clean while preserving compatibility with the terminal TUI.

[1]: https://pi.dev/docs/latest/sdk "Pi Coding Agent"
[2]: https://pi.dev/docs/latest/session-format "Pi Coding Agent"
[3]: https://github.com/badlogic/pi-mono/blob/main/packages/web-ui "pi-mono/packages/web-ui at main · badlogic/pi-mono · GitHub"
[4]: https://pi.dev/docs/latest/settings "Pi Coding Agent"
[5]: https://pi.dev/docs/latest/sessions "Pi Coding Agent"
[6]: https://pi.dev/docs/latest/usage "Pi Coding Agent"
[7]: https://pi.dev/docs/latest/rpc "Pi Coding Agent"
