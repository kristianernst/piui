# Pi web UI feasibility notes

Reviewed local Pi docs:

- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/README.md`
- `docs/sdk.md`
- `docs/rpc.md`
- `docs/json.md`
- `docs/session-format.md`
- `examples/sdk/12-full-control.ts`
- `examples/sdk/13-session-runtime.ts`

## Recommendation

Use the **Pi SDK in a local Node server** for `piui`.

Reasoning:

- The SDK is documented for custom UIs: `createAgentSession()`, `createAgentSessionRuntime()`, event subscriptions, session replacement, model/thinking controls, tools, resource loaders, settings, and auth storage.
- The browser frontend should not import Pi directly because Pi needs Node/system access and can execute OS tools.
- RPC mode is also viable, but the SDK gives type safety and no subprocess/framing layer for a Node-based app.

## Native integration model

`src/server/index.ts` uses:

- `createAgentSessionRuntime()` so the app can replace active sessions later (`newSession`, switch/fork/clone flows).
- `createAgentSessionServices({ cwd })` so Pi discovers the same cwd-bound resources it would in the terminal.
- `SessionManager.create(cwd)` so session files are normal Pi session JSONL files.
- `getAgentDir()` so credentials, settings, custom models, and global resources come from `~/.pi/agent`.
- `session.subscribe()` to stream Pi events into the WebSocket.

## Follow-up build plan

1. Add session browser using `SessionManager.list(cwd)` and `switchSession()`.
2. Add fork/tree UI using Pi's session tree IDs from JSONL entries.
3. Map extension UI requests to web dialogs if using RPC, or expose extension UI through SDK extension APIs.
4. Add permission/sandbox policy as a Pi extension rather than duplicating it in the browser.
5. Add file/image attachments and base64 image content handling.
6. Add production desktop wrapper later if desired; the current web server can be reused.
