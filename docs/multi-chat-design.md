I inspected the available `feature/multi-chat` branch and the Pi SDK/runtime evidence. The other model’s diagnosis is directionally right, but the recommendation needs to be sharpened: the core problem is no longer “agents stop when switching”; it is that the UI protocol still behaves like one foreground session with unscoped side effects.

The strongest evidence is that the Pi SDK treats session switching as runtime replacement, not harmless navigation. The SDK changelog says session replacement “fully reloads extensions,” can replace the live `AgentSession`, and requires callers to re-read `runtimeHost.session` and rebind session-local subscriptions after replacement.  The runtime source reinforces that `AgentSessionRuntimeHost` is a stable wrapper around a replaceable runtime, and `switchSession()`, `newSession()`, and `fork()` call `replace()`, dispose the old session, and install a new current session.  So user navigation must not call `runtime.switchSession()` if the old agent is meant to keep running.

Your current branch has already moved in the right direction: `WorkspaceStore.list()` preserves insertion order, `PiSessionInfo` includes `liveSessionId` and `isRunning`, and `listSessions()` annotates listed sessions against live runtime sessions.  But the protocol is still not truly multi-session. In `piSocket.ts`, `messages` is still typed as `{ messages }`, `event` is still just `{ event }`, and `state`, `resources`, `models`, `tree`, and extension UI packets are not first-class session-scoped packets.  In `main.tsx`, the branch has `sessionsByWorkspace`, but it still has one global `messages` array and applies `packet.type === "messages"` and `packet.type === "event"` directly to that global array.  That is the remaining architectural mismatch.

My final recommendation: use one `AgentSessionRuntime` per live session, but do not full-stream every background session into the visible chat. The server should maintain live runtimes keyed by a stable route, forward only status for inactive sessions, and make every session-related packet explicitly scoped. The client should maintain per-session transcript/state caches and only render the active route.

The runtime model should be:

```ts
type RuntimeId = string;

type SessionRoute = {
  runtimeId: RuntimeId;
  workspaceId: string;
  sessionPath?: string; // canonical once known
  sessionId: string;    // SDK identity, useful for orb seed/display
};

type RuntimeHandle = {
  id: RuntimeId;
  workspace: Workspace;
  runtime: AgentSessionRuntime;
  sessionPath?: string;

  seq: number;
  eventBuffer: Array<SessionScopedEvent>; // small ring buffer
  unsubscribe?: () => void;

  lockSessionFile?: string;
  readOnly: boolean;

  // Extension/UI state must not be global.
  widgetHost: WidgetHost;
  pendingUi: Map<string, (value: unknown) => void>;
  extensionUi: ExtensionUIContext;
};
```

Use `runtimeId` as the always-valid live identity. Use `sessionPath` as the canonical persisted conversation identity once it exists. Do not use SDK `sessionId` as the canonical key because it is useful for display and orb identity, but the file path is what prevents accidentally opening the same persisted conversation twice.

The maps should be:

```ts
const runtimesById = new Map<RuntimeId, RuntimeHandle>();
const runtimeIdBySessionKey = new Map<string, RuntimeId>();

let activeRuntimeId: RuntimeId | null = null;
let activeWorkspaceId: string | null = null;

function sessionKey(workspaceId: string, sessionPath: string) {
  return `${workspaceId}\0${sessionPath}`;
}

function routeFor(handle: RuntimeHandle): SessionRoute {
  const session = handle.runtime.session;
  return {
    runtimeId: handle.id,
    workspaceId: handle.workspace.id,
    sessionPath: session.sessionFile,
    sessionId: session.sessionId,
  };
}
```

For a new unsaved session, create a runtime with a provisional `runtimeId`. Once `session.sessionFile` exists, re-key it into `runtimeIdBySessionKey`. This avoids the brittle `"new"` synthetic key problem.

The packet protocol should change from unscoped packets to scoped packets. Keep `workspaces` global and `sessions`, `files`, and `git` workspace-scoped. Everything else that belongs to a conversation should carry the route.

```ts
type SessionScoped<T> = T & {
  runtimeId: string;
  workspaceId: string;
  sessionPath?: string;
  sessionId: string;
};

type ServerPacket =
  | { type: "workspaces"; data: { workspaces: Workspace[]; activeWorkspaceId: string } }
  | { type: "sessions"; data: { workspaceId: string; sessions: PiSessionInfo[] } }
  | { type: "git"; data: { workspaceId: string; snapshot: GitSnapshot } }

  | { type: "state"; data: SessionScoped<{ state: PiState; revision: number }> }
  | { type: "messages"; data: SessionScoped<{ messages: AgentMessage[]; revision: number }> }
  | { type: "event"; data: SessionScoped<{ event: AgentEvent; seq: number }> }
  | { type: "resources"; data: SessionScoped<{ resources: PiResourceSummary }> }
  | { type: "models"; data: SessionScoped<{ models: PiModelSummary[] }> }
  | { type: "tree"; data: SessionScoped<{ entries: PiTreeEntry[] }> }

  | { type: "extension_ui_request"; data: SessionScoped<{ request: ExtensionUiRequest }> }
  | { type: "extension_ui_status"; data: SessionScoped<{ key: string; text?: string; value?: unknown }> }
  | { type: "extension_ui_widget"; data: SessionScoped<{ slot: string; lines?: string[]; removed?: true }> }
  | { type: "extension_reset"; data: SessionScoped<{}> };
```

This is the single highest-leverage fix. Once packets carry `runtimeId/workspaceId/sessionPath`, stale sends after a switch are annoying but not corrupting: the client can ignore or cache them under the correct route.

For event ordering, do not rely only on `isCurrent()` guards. Use sequence numbers and snapshot revisions. Every runtime gets a monotonic `seq`. The server increments it for each subscribed event. When activating a session, send a full snapshot with `revision = handle.seq`. The client replaces only that session’s message cache and records that revision. Later events with `seq <= revision` are ignored for that session.

```ts
function attachRuntimeSubscription(handle: RuntimeHandle) {
  handle.unsubscribe = handle.runtime.session.subscribe((event) => {
    const seq = ++handle.seq;
    const route = routeFor(handle);

    const packet = {
      type: "event" as const,
      data: { ...route, event, seq },
    };

    pushEventBuffer(handle, packet);

    if (isStatusEvent(event)) {
      sendStateFor(handle);
      void sendSessionsForWorkspace(handle.workspace.id);
    }

    if (activeRuntimeId === handle.id) {
      send(ws, packet);
    }
  });
}
```

On activation:

```ts
async function activateRuntime(handle: RuntimeHandle) {
  activeRuntimeId = handle.id;
  activeWorkspaceId = handle.workspace.id;

  const route = routeFor(handle);
  const revision = handle.seq;

  bindForegroundExtensions(handle);

  send(ws, { type: "workspace", data: handle.workspace });

  send(ws, {
    type: "state",
    data: { ...route, state: publicState(handle.workspace, handle.runtime.session), revision },
  });

  send(ws, {
    type: "messages",
    data: { ...route, messages: handle.runtime.session.messages, revision },
  });

  send(ws, {
    type: "resources",
    data: { ...route, resources: publicResources(handle.runtime.session) },
  });

  send(ws, {
    type: "models",
    data: { ...route, models: publicModels(handle.runtime.session) },
  });

  send(ws, {
    type: "tree",
    data: { ...route, entries: publicTree(handle.runtime.session) },
  });

  // Flush events that arrived after the snapshot revision.
  for (const packet of handle.eventBuffer) {
    if (packet.data.seq > revision) send(ws, packet);
  }

  await sendSessionsForWorkspace(handle.workspace.id);
  await sendWorkspaceScopedSidecars(handle.workspace.id);
}
```

Also send a fresh `messages` snapshot after `agent_end`, `compaction_end`, and possibly `message_end` for assistant messages. That is a cheap reconciliation step. It means the client may stream from deltas, but the canonical transcript is periodically reset from `session.messages`.

On the client, replace:

```ts
const [messages, setMessages] = useState<UiMessage[]>([]);
```

with:

```ts
type SessionCache = {
  route: SessionRoute;
  messages: UiMessage[];
  lastRevision: number;
  lastSeq: number;
};

const [activeRoute, setActiveRoute] = useState<SessionRoute | null>(null);
const [threadsByKey, setThreadsByKey] = useState<Record<string, SessionCache>>({});

function routeKey(route: Pick<SessionRoute, "workspaceId" | "sessionPath" | "runtimeId">) {
  return route.sessionPath
    ? `${route.workspaceId}\0${route.sessionPath}`
    : `runtime:${route.runtimeId}`;
}

const messages = activeRoute
  ? threadsByKey[routeKey(activeRoute)]?.messages ?? []
  : [];
```

Then route packet handling:

```ts
if (packet.type === "messages") {
  const key = routeKey(packet.data);
  const ui = hydrateToolOutputs(
    packet.data.messages,
    asMessages(packet.data.messages),
  );

  setThreadsByKey((prev) => ({
    ...prev,
    [key]: {
      route: packet.data,
      messages: ui,
      lastRevision: packet.data.revision,
      lastSeq: Math.max(prev[key]?.lastSeq ?? 0, packet.data.revision),
    },
  }));

  return;
}

if (packet.type === "event") {
  const key = routeKey(packet.data);

  setThreadsByKey((prev) => {
    const current = prev[key];
    if (current && packet.data.seq <= current.lastSeq) return prev;

    const base = current?.messages ?? [];
    const next = applyEventToMessages(base, packet.data.event);

    return {
      ...prev,
      [key]: {
        route: packet.data,
        messages: next,
        lastRevision: current?.lastRevision ?? 0,
        lastSeq: packet.data.seq,
      },
    };
  });

  return;
}
```

`applyEvent()` should become pure:

```ts
function applyEventToMessages(prev: UiMessage[], event: AgentEvent): UiMessage[] {
  // current applyEvent logic, but return the new array instead of calling setMessages()
}
```

This matters. Right now `applyEvent()` closes over one global active transcript. With multiple running agents, event application must be a pure projection from `(sessionKey, oldMessages, event) -> newMessages`.

For optimistic user messages, stop deduping by text globally. Two identical prompts in the same session are legitimate. Use a client-generated optimistic id and keep it per session:

```ts
function sendPrompt(text: string, streamingBehavior?: "steer" | "followUp") {
  const route = activeRouteRef.current;
  if (!route) return;

  const key = routeKey(route);
  const clientMessageId = crypto.randomUUID();

  setThreadsByKey((prev) => {
    const current = prev[key];
    return {
      ...prev,
      [key]: {
        route,
        messages: [
          ...(current?.messages ?? []),
          { id: `optimistic:${clientMessageId}`, role: "user", text },
        ],
        lastRevision: current?.lastRevision ?? 0,
        lastSeq: current?.lastSeq ?? 0,
      },
    };
  });

  socketRef.current?.send({
    type: "prompt",
    ...route,
    clientMessageId,
    message: text,
    streamingBehavior,
  });
}
```

If Pi does not echo `clientMessageId`, reconcile by snapshot replacement rather than fragile text matching. The current “if any previous user message has same text, skip” is too broad.

For background sessions, I would use status-subscribed, not fully client-subscribed and not disk-only. Disk-only cannot show accurate running state. Fully streaming all background transcript deltas to the browser is unnecessary and increases routing risk. The server should subscribe to every live runtime, maintain `seq`, update sidebar state, and send only status/session-list changes for inactive sessions. When the user returns to a conversation, send a full snapshot from the live runtime.

Use this event filter for status refreshes:

```ts
const statusEvents = new Set([
  "agent_start",
  "agent_end",
  "tool_execution_start",
  "tool_execution_end",
  "message_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "session_info_changed",
]);
```

Throttle session-list refreshes. Do not refresh `sessions` on every text delta.

Extension UI needs the same scoping treatment. A single `widgetHost`, `pendingUi`, and `extensionUi` is unsafe. The Pi `AgentSession.dispose()` invalidates extension contexts after session replacement/reload, explicitly warning not to use stale captured contexts.  In your app, even without replacement, a background session can still hold a UI context that points at the active browser surface if that context is global. That is enough to corrupt foreground UI.

Each `RuntimeHandle` should own:

```ts
widgetHost: WidgetHost;
pendingUi: Map<string, (value: unknown) => void>;
extensionUi: ExtensionUIContext;
```

`createExtensionUI()` should close over the runtime route:

```ts
function createExtensionUIFor(handle: RuntimeHandle): ExtensionUIContext {
  const pendingUi = handle.pendingUi;
  const widgetHost = handle.widgetHost;

  function scoped<T extends object>(payload: T) {
    return { ...routeFor(handle), ...payload };
  }

  return {
    async select(title, options, opts) {
      const id = crypto.randomUUID();

      send(ws, {
        type: "extension_ui_request",
        data: scoped({ request: { id, kind: "select", title, options, opts } }),
      });

      return new Promise((resolve) => pendingUi.set(id, resolve));
    },

    // same for confirm/input/status/widgets
  };
}
```

The client should keep `extensionBySession`, just like `messagesBySession`. It should render extension UI only for `activeRoute`. `extension_ui_response`, `extension_input`, and `trigger_shortcut` must include `runtimeId` or the full route, and the server must resolve them against that runtime’s `pendingUi` and `widgetHost`, not a global one.

For background extension UI, choose one policy now. The minimal safe policy is: queue route-scoped requests and show a sidebar badge/notification, but never render them into the active session’s composer or overlay. Dropping them is safer than corrupting the active UI but may break extensions that need a user answer. Queuing is better.

Locks should be held by live runtime, not by active selection. Switching away must not release the lock. Reopening an already-live session should reuse the existing runtime and existing lock. Closing the WebSocket releases all runtime locks. Deleting a session should refuse if any live runtime has that `sessionPath`; disposing idle live runtimes before delete is a later feature.

The minimal server command changes are:

```ts
async function openRuntimeForSession(workspace: Workspace, sessionPath: string) {
  const key = sessionKey(workspace.id, sessionPath);
  const existingId = runtimeIdBySessionKey.get(key);
  if (existingId) return runtimesById.get(existingId)!;

  const lock = await locks.claim(sessionPath, workspace, ownerId);
  if (lock.owner === "other") throw lockConflictError(sessionPath, lock.lock);

  const handle = await createRuntimeHandle(workspace, {
    mode: "open",
    sessionPath,
    readOnly: false,
    lockSessionFile: sessionPath,
  });

  runtimeIdBySessionKey.set(key, handle.id);
  runtimesById.set(handle.id, handle);
  attachRuntimeSubscription(handle);

  return handle;
}

async function switchSessionCommand(command: ClientCommand) {
  const workspace = workspaceFromCommand(store, activeWorkspace, command.workspaceId);
  if (!command.sessionPath) throw new Error("Missing sessionPath");

  const handle = await openRuntimeForSession(workspace, command.sessionPath);
  await activateRuntime(handle);

  send(ws, {
    type: "response",
    id: command.id,
    command: command.type,
    success: true,
    data: { runtimeId: handle.id, sessionPath: handle.runtime.session.sessionFile },
  });
}
```

For `new_session`, do not call `activeRuntime.runtime.newSession()` as navigation. Create a new runtime:

```ts
async function newSessionCommand(command: ClientCommand) {
  const workspace = workspaceFromCommand(store, activeWorkspace, command.workspaceId);
  const handle = await createRuntimeHandle(workspace, { mode: "new" });

  runtimesById.set(handle.id, handle);
  attachRuntimeSubscription(handle);
  await activateRuntime(handle);

  send(ws, {
    type: "response",
    id: command.id,
    command: command.type,
    success: true,
    data: { runtimeId: handle.id, sessionPath: handle.runtime.session.sessionFile },
  });
}
```

Be careful with `createCommandActions(handle)`. Its current shape is dangerous if it exposes `handle.runtime.switchSession()` and `handle.runtime.newSession()` directly. For multi-session UI, extension/builtin session replacement actions need to go through your runtime registry so maps, locks, extension UI, subscriptions, and active route are updated atomically. For a minimal stabilization pass, I would disable or wrap extension-driven `switchSession/newSession/fork` rather than leaving raw runtime replacement in place.

The ten-pass critique I would use to converge on this:

1. Workspace runtime caching helps, but it only solves workspace switching. Conversation switching still breaks because SDK session switching is replacement.

2. Runtime-per-session is the right primitive for live conversations, but it does not solve routing by itself. A foreground global event pipe can still mix transcripts.

3. Keying by `workspaceId + sessionPath` is right for persisted sessions, but new sessions need a provisional `runtimeId` until `sessionFile` exists.

4. A single global client `messages` array is incompatible with simultaneous sessions. It must become `messagesBySession`.

5. Session-scoped packets are not optional. Client-side per-session caches cannot work reliably if `messages`, `event`, `state`, and extension packets do not carry route identity.

6. Full background streaming is overkill. It increases network traffic and extension/UI risk. Use server-side subscriptions for status and sequence tracking; send full transcript snapshots on activation.

7. Snapshot-only on activation is almost enough, but not robust during active streaming. Add per-runtime sequence numbers and snapshot revisions, then reconcile with fresh snapshots at `agent_end`.

8. Server-side transcript projection would be cleanest long-term, but it is a larger refactor. The minimal stable step is route-scoped event projection plus canonical snapshot replacement.

9. Global extension UI is a hidden cross-session corruption path. Extension UI, widget host, pending UI requests, shortcuts, and raw input must be scoped per runtime.

10. Locks should follow runtime ownership, not UI selection. Do not release locks on navigation; do reject live deletes; dispose/release all runtimes on WebSocket close.

So the practical final plan is:

First, change the protocol and client state. Add `runtimeId`, `workspaceId`, `sessionPath`, `sessionId`, and `seq/revision` to session packets. Convert `messages` to `messagesBySession`. Ignore or cache packets by route. This is the most important stabilization step.

Second, make the server registry explicit. Use `runtimesById` plus `runtimeIdBySessionKey`. Treat activation as a foreground binding operation only. Do not dispose or `switchSession()` for navigation.

Third, add per-runtime event sequence and activation snapshots. Send status for inactive runtimes, not full chat deltas. On returning to a session, replace that session’s transcript from `session.messages`.

Fourth, scope extension UI per runtime. No global `widgetHost`, `pendingUi`, or `extensionUi`. Queue or badge background extension requests, but never let them mutate the active foreground surface.

Fifth, wrap or temporarily disable extension-driven session replacement actions until they are integrated with the runtime registry. Raw `runtime.switchSession()` inside `createCommandActions()` is the main remaining way to reintroduce replacement semantics accidentally.

This is not a full rewrite. It is a protocol/routing refactor plus a small runtime registry. The main rule is: navigation changes `activeRuntimeId`; it never mutates or replaces another live session.
