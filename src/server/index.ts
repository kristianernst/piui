import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionUIContext,
  type SessionEntry,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? 5174);
const initialCwd = path.resolve(process.env.PIUI_CWD ?? process.cwd());
const agentDir = getAgentDir();
const workspaceFile = path.join(agentDir, "piui-workspaces.json");
const lockFile = path.join(agentDir, "piui-runtime-locks.json");
const localToken = process.env.PIUI_TOKEN ?? crypto.randomBytes(24).toString("base64url");
const allowedOrigins = new Set(
  (process.env.PIUI_ORIGINS ?? `http://127.0.0.1:${port},http://localhost:${port}`)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const writeCommands = new Set<ClientCommand["type"]>([
  "prompt",
  "steer",
  "follow_up",
  "compact",
  "set_session_name",
  "cycle_model",
  "set_model",
  "set_thinking_level",
]);

type Workspace = {
  id: string;
  cwd: string;
  name: string;
  lastOpenedAt: string;
};

type ClientCommand = {
  id?: string;
  type:
    | "list_workspaces"
    | "open_workspace"
    | "switch_workspace"
    | "remove_workspace"
    | "list_sessions"
    | "switch_session"
    | "continue_recent"
    | "get_state"
    | "get_messages"
    | "get_resources"
    | "get_models"
    | "get_tree"
    | "prompt"
    | "steer"
    | "follow_up"
    | "abort"
    | "new_session"
    | "fork"
    | "clone"
    | "compact"
    | "set_session_name"
    | "export_html"
    | "cycle_model"
    | "set_model"
    | "set_thinking_level"
    | "extension_ui_response";
  cwd?: string;
  name?: string;
  workspaceId?: string;
  sessionPath?: string;
  entryId?: string;
  customInstructions?: string;
  message?: string;
  streamingBehavior?: "steer" | "followUp";
  provider?: string;
  modelId?: string;
  level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  uiRequestId?: string;
  value?: unknown;
};

type ServerPacket =
  | { type: "ready"; data: unknown }
  | { type: "workspaces"; data: unknown }
  | { type: "workspace"; data: unknown }
  | { type: "sessions"; data: unknown }
  | { type: "state"; data: unknown }
  | { type: "messages"; data: unknown }
  | { type: "resources"; data: unknown }
  | { type: "models"; data: unknown }
  | { type: "tree"; data: unknown }
  | { type: "extension_ui_request"; request: unknown }
  | { type: "extension_ui_status"; data: unknown }
  | { type: "notification"; data: { message: string; level?: "info" | "warning" | "error" } }
  | { type: "event"; event: unknown }
  | { type: "response"; id?: string; command: string; success: boolean; data?: unknown; error?: string };

function send(ws: WebSocket, packet: ServerPacket) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(packet));
}

function workspaceId(cwd: string) {
  return crypto.createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 12);
}

function workspaceName(cwd: string) {
  const base = path.basename(cwd);
  return base || cwd;
}

async function assertDirectory(cwd: string) {
  const stat = await fs.stat(cwd);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${cwd}`);
}

function expandHome(input: string) {
  return input.replace(/^~(?=$|\/)/, os.homedir());
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`Could not load ${filePath}:`, error);
    return fallback;
  }
}

async function writeJsonFile(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

class WorkspaceStore {
  private workspaces = new Map<string, Workspace>();

  async load() {
    await fs.mkdir(path.dirname(workspaceFile), { recursive: true });
    const data = await readJsonFile<{ workspaces?: Workspace[] }>(workspaceFile, {});
    for (const workspace of data.workspaces ?? []) this.workspaces.set(workspace.id, workspace);
    await this.add(initialCwd);
  }

  list() {
    return [...this.workspaces.values()].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  }

  get(id: string) {
    return this.workspaces.get(id);
  }

  async add(cwdInput: string, name?: string) {
    const cwd = path.resolve(expandHome(cwdInput));
    await assertDirectory(cwd);
    const id = workspaceId(cwd);
    const existing = this.workspaces.get(id);
    const workspace: Workspace = {
      id,
      cwd,
      name: name?.trim() || existing?.name || workspaceName(cwd),
      lastOpenedAt: new Date().toISOString(),
    };
    this.workspaces.set(id, workspace);
    await this.save();
    return workspace;
  }

  async touch(id: string) {
    const workspace = this.workspaces.get(id);
    if (!workspace) throw new Error(`Unknown workspace: ${id}`);
    workspace.lastOpenedAt = new Date().toISOString();
    await this.save();
    return workspace;
  }

  async remove(id: string) {
    const removed = this.workspaces.delete(id);
    await this.save();
    return removed;
  }

  private async save() {
    await writeJsonFile(workspaceFile, { workspaces: this.list() });
  }
}

type SessionLock = {
  sessionFile: string;
  workspaceId: string;
  cwd: string;
  pid: number;
  token: string;
  updatedAt: string;
};

class LockStore {
  private locks = new Map<string, SessionLock>();

  async load() {
    const data = await readJsonFile<{ locks?: SessionLock[] }>(lockFile, {});
    const now = Date.now();
    for (const lock of data.locks ?? []) {
      const ageMs = now - Date.parse(lock.updatedAt);
      if (Number.isFinite(ageMs) && ageMs < 24 * 60 * 60 * 1000) this.locks.set(lock.sessionFile, lock);
    }
  }

  async claim(sessionFile: string | undefined, workspace: Workspace) {
    if (!sessionFile) return { owner: "none" as const };
    const existing = this.locks.get(sessionFile);
    if (existing && existing.pid !== process.pid && existing.token !== localToken) {
      return { owner: "other" as const, lock: existing };
    }
    const lock: SessionLock = {
      sessionFile,
      workspaceId: workspace.id,
      cwd: workspace.cwd,
      pid: process.pid,
      token: localToken,
      updatedAt: new Date().toISOString(),
    };
    this.locks.set(sessionFile, lock);
    await this.save();
    return { owner: "self" as const, lock };
  }

  async release(sessionFile: string | undefined) {
    if (!sessionFile) return;
    const existing = this.locks.get(sessionFile);
    if (existing?.token === localToken) {
      this.locks.delete(sessionFile);
      await this.save();
    }
  }

  private async save() {
    await writeJsonFile(lockFile, { locks: [...this.locks.values()] });
  }
}

type RuntimeHandle = {
  workspace: Workspace;
  runtime: Awaited<ReturnType<typeof createRuntimeFor>>;
};

async function createRuntimeFor(cwd: string, mode: "new" | "continue" | "open" = "new", sessionPath?: string) {
  const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd });
    return {
      ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  const sessionManager =
    mode === "continue"
      ? SessionManager.continueRecent(cwd)
      : mode === "open" && sessionPath
        ? SessionManager.open(sessionPath, undefined, cwd)
        : SessionManager.create(cwd);

  return createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager });
}

class RuntimeManager {
  private handles = new Map<string, RuntimeHandle>();

  async get(workspace: Workspace) {
    let handle = this.handles.get(workspace.id);
    if (!handle) {
      handle = { workspace, runtime: await createRuntimeFor(workspace.cwd) };
      this.handles.set(workspace.id, handle);
    }
    return handle;
  }

  async recreate(workspace: Workspace, mode: "new" | "continue" | "open", sessionPath?: string) {
    await this.dispose(workspace.id);
    const handle = { workspace, runtime: await createRuntimeFor(workspace.cwd, mode, sessionPath) };
    this.handles.set(workspace.id, handle);
    return handle;
  }

  async dispose(workspaceId: string) {
    const existing = this.handles.get(workspaceId);
    if (!existing) return;
    await (existing.runtime as unknown as { dispose?: () => Promise<void> | void }).dispose?.();
    this.handles.delete(workspaceId);
  }
}

function publicState(workspace: Workspace, session: AgentSession) {
  const model = session.model;
  const messages = session.messages ?? [];
  const assistantMessages = messages.filter((message) => message.role === "assistant") as Array<{
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } };
  }>;
  const latestUsage = [...assistantMessages].reverse().find((message) => message.usage)?.usage;
  const tokenEstimate = latestUsage?.totalTokens ?? latestUsage?.input ?? 0;

  return {
    workspace,
    cwd: workspace.cwd,
    sessionFile: session.sessionFile,
    sessionId: session.sessionId,
    isStreaming: session.isStreaming,
    model,
    thinkingLevel: session.thinkingLevel,
    isCompacting: session.isCompacting,
    isRetrying: session.isRetrying,
    pending: {
      steering: session.getSteeringMessages(),
      followUp: session.getFollowUpMessages(),
    },
    activeTools: session.getActiveToolNames(),
    messageCount: messages.length,
    usage: latestUsage
      ? {
          tokens: tokenEstimate,
          contextWindow: model?.contextWindow,
          percent: model?.contextWindow ? Math.min(100, Math.round((tokenEstimate / model.contextWindow) * 100)) : null,
          cost: latestUsage.cost?.total,
        }
      : null,
  };
}

async function listSessions(cwd: string) {
  const sessions = await SessionManager.list(cwd);
  return sessions.slice(0, 50).map((session) => ({
    path: session.path,
    id: session.id,
    cwd: session.cwd,
    name: session.name,
    created: session.created,
    modified: session.modified,
    messageCount: session.messageCount,
    firstMessage: session.firstMessage,
  }));
}

function publicResources(session: AgentSession) {
  const skills = session.resourceLoader.getSkills();
  const prompts = session.resourceLoader.getPrompts();
  return {
    commands: [
      { name: "new", description: "Start a new session", source: "builtin" },
      { name: "resume", description: "Resume or switch sessions", source: "builtin" },
      { name: "tree", description: "Inspect the session tree", source: "builtin" },
      { name: "fork", description: "Fork from a previous user message", source: "builtin" },
      { name: "clone", description: "Clone the current branch", source: "builtin" },
      { name: "compact", description: "Summarize older context", source: "builtin" },
      { name: "model", description: "Change model", source: "builtin" },
      { name: "settings", description: "Open settings in native Pi", source: "builtin" },
      ...session.promptTemplates.map((prompt) => ({ name: prompt.name, description: prompt.description, source: "prompt" })),
      ...skills.skills.map((skill) => ({ name: `skill:${skill.name}`, description: skill.description, source: "skill" })),
    ],
    tools: session.getAllTools(),
    activeTools: session.getActiveToolNames(),
    prompts: prompts.prompts,
    skills: skills.skills,
    agentsFiles: session.resourceLoader.getAgentsFiles().agentsFiles.map((file) => ({ path: file.path })),
    diagnostics: [...skills.diagnostics, ...prompts.diagnostics],
  };
}

function publicModels(session: AgentSession) {
  const registry = session.modelRegistry;
  return registry.getAll().map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    available: registry.hasConfiguredAuth(model),
    current: session.model?.provider === model.provider && session.model?.id === model.id,
  }));
}

function publicTree(session: AgentSession) {
  const forkable = new Set(session.getUserMessagesForForking().map((entry) => entry.entryId));
  return session.sessionManager.getEntries().map((entry: SessionEntry) => ({
    id: entry.id,
    parentId: entry.parentId,
    type: entry.type,
    timestamp: entry.timestamp,
    forkable: forkable.has(entry.id),
    label: session.sessionManager.getLabel(entry.id),
    text:
      entry.type === "message" && entry.message.role === "user"
        ? typeof entry.message.content === "string"
          ? entry.message.content
          : "[user content]"
        : undefined,
  }));
}

function createExtensionUI(ws: WebSocket, pendingUi: Map<string, (value: unknown) => void>): ExtensionUIContext {
  function request<T>(kind: string, payload: Record<string, unknown>) {
    const requestId = crypto.randomUUID();
    send(ws, { type: "extension_ui_request", request: { id: requestId, kind, ...payload } });
    return new Promise<T | undefined>((resolve) => {
      pendingUi.set(requestId, (value) => resolve(value as T | undefined));
      setTimeout(() => {
        if (pendingUi.delete(requestId)) resolve(undefined);
      }, 10 * 60 * 1000).unref();
    });
  }

  return {
    select: (title: string, options: string[], opts?: unknown) => request<string>("select", { title, options, opts }),
    confirm: async (title: string, message: string, opts?: unknown) => Boolean(await request<boolean>("confirm", { title, message, opts })),
    input: (title: string, placeholder?: string, opts?: unknown) => request<string>("input", { title, placeholder, opts }),
    notify: (message: string, level?: "info" | "warning" | "error") => send(ws, { type: "notification", data: { message, level } }),
    onTerminalInput: () => () => undefined,
    setStatus: (key: string, text: string | undefined) => send(ws, { type: "extension_ui_status", data: { key, text } }),
    setWorkingMessage: (message?: string) => send(ws, { type: "extension_ui_status", data: { key: "workingMessage", text: message } }),
    setWorkingVisible: (visible: boolean) => send(ws, { type: "extension_ui_status", data: { key: "workingVisible", value: visible } }),
    setWorkingIndicator: (options?: unknown) => send(ws, { type: "extension_ui_status", data: { key: "workingIndicator", value: options } }),
    setHiddenThinkingLabel: (label?: string) => send(ws, { type: "extension_ui_status", data: { key: "hiddenThinkingLabel", text: label } }),
    setWidget: (key: string, content: unknown) => send(ws, { type: "extension_ui_status", data: { key: `widget:${key}`, value: Array.isArray(content) ? content : undefined } }),
    setFooter: () => undefined,
    setHeader: () => undefined,
    setTitle: (title: string) => send(ws, { type: "extension_ui_status", data: { key: "title", text: title } }),
    custom: async <T,>() => undefined as T,
    pasteToEditor: (text: string) => send(ws, { type: "extension_ui_status", data: { key: "pasteToEditor", text } }),
    setEditorText: (text: string) => send(ws, { type: "extension_ui_status", data: { key: "setEditorText", text } }),
    getEditorText: () => "",
    editor: (title: string, prefill?: string) => request<string>("editor", { title, prefill }),
    addAutocompleteProvider: () => undefined,
    setEditorComponent: () => undefined,
    getEditorComponent: () => undefined,
    theme: undefined,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Themes are managed by the browser UI." }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => undefined,
  } as unknown as ExtensionUIContext;
}

async function bindSession(ws: WebSocket, handle: RuntimeHandle, pendingUi: Map<string, (value: unknown) => void>, locks: LockStore, unsubscribe?: () => void) {
  unsubscribe?.();
  const session = handle.runtime.session;
  const lock = await locks.claim(session.sessionFile, handle.workspace);
  await session.bindExtensions({ uiContext: createExtensionUI(ws, pendingUi) });
  const nextUnsubscribe = session.subscribe((event) => {
    send(ws, { type: "event", event });
    if (["agent_start", "agent_end", "queue_update", "compaction_start", "compaction_end", "message_end", "tool_execution_end", "thinking_level_changed", "session_info_changed"].includes(event.type)) {
      send(ws, { type: "state", data: publicState(handle.workspace, session) });
    }
  });
  send(ws, { type: "workspace", data: handle.workspace });
  send(ws, { type: "state", data: publicState(handle.workspace, session) });
  send(ws, { type: "messages", data: { messages: session.messages } });
  send(ws, { type: "sessions", data: { workspaceId: handle.workspace.id, sessions: await listSessions(handle.workspace.cwd) } });
  send(ws, { type: "resources", data: publicResources(session) });
  send(ws, { type: "models", data: { models: publicModels(session) } });
  send(ws, { type: "tree", data: { entries: publicTree(session) } });
  if (lock.owner === "other") {
    send(ws, { type: "notification", data: { level: "warning", message: `Session file is already owned by PID ${lock.lock.pid}; avoid writing from two runtimes.` } });
  }
  return { unsubscribe: nextUnsubscribe, readOnly: lock.owner === "other" };
}

async function main() {
  const store = new WorkspaceStore();
  const locks = new LockStore();
  await store.load();
  await locks.load();
  const runtimes = new RuntimeManager();

  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    verifyClient(info: { origin: string; req: http.IncomingMessage }) {
      const origin = info.origin;
      const token = new URL(info.req.url ?? "/ws", `http://${info.req.headers.host}`).searchParams.get("token");
      return (!origin || allowedOrigins.has(origin)) && token === localToken;
    },
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, cwd: initialCwd, mode: isProduction ? "production" : "development", workspaces: store.list().length, wsToken: localToken });
  });

  app.get("/api/workspaces", (_req, res) => res.json({ workspaces: store.list() }));
  app.post("/api/workspaces", async (req, res) => {
    try {
      res.json({ workspace: await store.add(String(req.body?.cwd ?? ""), req.body?.name ? String(req.body.name) : undefined) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  if (isProduction) {
    const staticDir = path.resolve(__dirname, "../client");
    app.use(express.static(staticDir));
    app.get("*", (_req, res) => res.sendFile(path.join(staticDir, "index.html")));
  } else {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  }

  wss.on("connection", async (ws) => {
    let activeWorkspace = store.list()[0];
    let handle: RuntimeHandle | undefined;
    let unsubscribe: (() => void) | undefined;
    let readOnly = false;
    const pendingUi = new Map<string, (value: unknown) => void>();

    async function activate(workspace: Workspace, options?: { mode?: "new" | "continue" | "open"; sessionPath?: string }) {
      if (handle?.runtime.session.sessionFile) await locks.release(handle.runtime.session.sessionFile);
      activeWorkspace = await store.touch(workspace.id);
      handle = options?.mode ? await runtimes.recreate(activeWorkspace, options.mode, options.sessionPath) : await runtimes.get(activeWorkspace);
      const binding = await bindSession(ws, handle, pendingUi, locks, unsubscribe);
      unsubscribe = binding.unsubscribe;
      readOnly = binding.readOnly;
      send(ws, { type: "workspaces", data: { workspaces: store.list(), activeWorkspaceId: activeWorkspace.id } });
      return handle;
    }

    try {
      await activate(activeWorkspace);
      send(ws, { type: "ready", data: { workspaces: store.list(), activeWorkspaceId: activeWorkspace.id, state: publicState(activeWorkspace, handle!.runtime.session) } });
    } catch (error) {
      send(ws, { type: "response", command: "connect", success: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    ws.on("message", async (raw) => {
      let command: ClientCommand;
      try {
        command = JSON.parse(raw.toString()) as ClientCommand;
      } catch (error) {
        send(ws, { type: "response", command: "parse", success: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }

      const id = command.id;
      try {
        if (readOnly && writeCommands.has(command.type)) {
          throw new Error("This session is read-only because another Pi runtime owns its session file. Switch to another session, clone it, or close the other runtime.");
        }
        switch (command.type) {
          case "list_workspaces":
            send(ws, { type: "response", id, command: command.type, success: true, data: { workspaces: store.list(), activeWorkspaceId: activeWorkspace.id } });
            send(ws, { type: "workspaces", data: { workspaces: store.list(), activeWorkspaceId: activeWorkspace.id } });
            break;
          case "open_workspace": {
            if (!command.cwd) throw new Error("Missing cwd");
            const workspace = await store.add(command.cwd, command.name);
            await activate(workspace);
            send(ws, { type: "response", id, command: command.type, success: true, data: { workspace } });
            break;
          }
          case "switch_workspace": {
            if (!command.workspaceId) throw new Error("Missing workspaceId");
            const workspace = store.get(command.workspaceId);
            if (!workspace) throw new Error(`Unknown workspace: ${command.workspaceId}`);
            await activate(workspace);
            send(ws, { type: "response", id, command: command.type, success: true, data: { workspace } });
            break;
          }
          case "remove_workspace": {
            if (!command.workspaceId) throw new Error("Missing workspaceId");
            await runtimes.dispose(command.workspaceId);
            await store.remove(command.workspaceId);
            const next = store.list()[0] ?? (await store.add(initialCwd));
            await activate(next);
            send(ws, { type: "response", id, command: command.type, success: true });
            break;
          }
          case "list_sessions":
            send(ws, { type: "response", id, command: command.type, success: true, data: { sessions: await listSessions(activeWorkspace.cwd) } });
            send(ws, { type: "sessions", data: { workspaceId: activeWorkspace.id, sessions: await listSessions(activeWorkspace.cwd) } });
            break;
          case "switch_session":
            if (!command.sessionPath) throw new Error("Missing sessionPath");
            await activate(activeWorkspace, { mode: "open", sessionPath: command.sessionPath });
            send(ws, { type: "response", id, command: command.type, success: true });
            break;
          case "continue_recent":
            await activate(activeWorkspace, { mode: "continue" });
            send(ws, { type: "response", id, command: command.type, success: true });
            break;
          case "new_session":
            const previousSessionFile = handle!.runtime.session.sessionFile;
            await handle!.runtime.newSession();
            await locks.release(previousSessionFile);
            {
              const binding = await bindSession(ws, handle!, pendingUi, locks, unsubscribe);
              unsubscribe = binding.unsubscribe;
              readOnly = binding.readOnly;
            }
            send(ws, { type: "response", id, command: command.type, success: true });
            break;
          case "get_state":
            send(ws, { type: "response", id, command: command.type, success: true, data: publicState(activeWorkspace, handle!.runtime.session) });
            break;
          case "get_messages":
            send(ws, { type: "response", id, command: command.type, success: true, data: { messages: handle!.runtime.session.messages } });
            break;
          case "get_resources":
            send(ws, { type: "response", id, command: command.type, success: true, data: publicResources(handle!.runtime.session) });
            send(ws, { type: "resources", data: publicResources(handle!.runtime.session) });
            break;
          case "get_models":
            send(ws, { type: "response", id, command: command.type, success: true, data: { models: publicModels(handle!.runtime.session) } });
            send(ws, { type: "models", data: { models: publicModels(handle!.runtime.session) } });
            break;
          case "get_tree":
            send(ws, { type: "response", id, command: command.type, success: true, data: { entries: publicTree(handle!.runtime.session) } });
            send(ws, { type: "tree", data: { entries: publicTree(handle!.runtime.session) } });
            break;
          case "prompt": {
            const session = handle!.runtime.session;
            if (!command.message?.trim()) throw new Error("Missing message");
            send(ws, { type: "response", id, command: command.type, success: true });
            await session.prompt(command.message, { streamingBehavior: command.streamingBehavior });
            send(ws, { type: "state", data: publicState(activeWorkspace, session) });
            send(ws, { type: "sessions", data: { workspaceId: activeWorkspace.id, sessions: await listSessions(activeWorkspace.cwd) } });
            send(ws, { type: "tree", data: { entries: publicTree(session) } });
            break;
          }
          case "steer":
            if (!command.message?.trim()) throw new Error("Missing message");
            await handle!.runtime.session.steer(command.message);
            send(ws, { type: "response", id, command: command.type, success: true });
            break;
          case "follow_up":
            if (!command.message?.trim()) throw new Error("Missing message");
            await handle!.runtime.session.followUp(command.message);
            send(ws, { type: "response", id, command: command.type, success: true });
            break;
          case "abort":
            await handle!.runtime.session.abort();
            send(ws, { type: "response", id, command: command.type, success: true });
            break;
          case "fork":
            if (!command.entryId) throw new Error("Missing entryId");
            const previousForkSessionFile = handle!.runtime.session.sessionFile;
            await handle!.runtime.fork(command.entryId, { position: "before" });
            await locks.release(previousForkSessionFile);
            {
              const binding = await bindSession(ws, handle!, pendingUi, locks, unsubscribe);
              unsubscribe = binding.unsubscribe;
              readOnly = binding.readOnly;
            }
            send(ws, { type: "response", id, command: command.type, success: true });
            break;
          case "clone": {
            const leafId = handle!.runtime.session.sessionManager.getLeafId();
            if (!leafId) throw new Error("No current session entry to clone");
            const previousCloneSessionFile = handle!.runtime.session.sessionFile;
            await handle!.runtime.fork(leafId, { position: "at" });
            await locks.release(previousCloneSessionFile);
            {
              const binding = await bindSession(ws, handle!, pendingUi, locks, unsubscribe);
              unsubscribe = binding.unsubscribe;
              readOnly = binding.readOnly;
            }
            send(ws, { type: "response", id, command: command.type, success: true });
            break;
          }
          case "compact": {
            const result = await handle!.runtime.session.compact(command.customInstructions);
            send(ws, { type: "response", id, command: command.type, success: true, data: result });
            send(ws, { type: "messages", data: { messages: handle!.runtime.session.messages } });
            send(ws, { type: "tree", data: { entries: publicTree(handle!.runtime.session) } });
            break;
          }
          case "set_session_name":
            handle!.runtime.session.setSessionName(command.name ?? "");
            send(ws, { type: "response", id, command: command.type, success: true });
            send(ws, { type: "sessions", data: { workspaceId: activeWorkspace.id, sessions: await listSessions(activeWorkspace.cwd) } });
            send(ws, { type: "state", data: publicState(activeWorkspace, handle!.runtime.session) });
            break;
          case "export_html": {
            const outputPath = await handle!.runtime.session.exportToHtml();
            send(ws, { type: "response", id, command: command.type, success: true, data: { outputPath } });
            send(ws, { type: "notification", data: { level: "info", message: `Exported session to ${outputPath}` } });
            break;
          }
          case "cycle_model": {
            const result = await handle!.runtime.session.cycleModel();
            send(ws, { type: "response", id, command: command.type, success: true, data: result });
            send(ws, { type: "state", data: publicState(activeWorkspace, handle!.runtime.session) });
            send(ws, { type: "models", data: { models: publicModels(handle!.runtime.session) } });
            break;
          }
          case "set_model": {
            if (!command.provider || !command.modelId) throw new Error("Missing provider/modelId");
            const model = handle!.runtime.session.modelRegistry.find(command.provider, command.modelId);
            if (!model) throw new Error(`Unknown model: ${command.provider}/${command.modelId}`);
            await handle!.runtime.session.setModel(model);
            send(ws, { type: "response", id, command: command.type, success: true });
            send(ws, { type: "state", data: publicState(activeWorkspace, handle!.runtime.session) });
            send(ws, { type: "models", data: { models: publicModels(handle!.runtime.session) } });
            break;
          }
          case "set_thinking_level":
            if (!command.level) throw new Error("Missing thinking level");
            handle!.runtime.session.setThinkingLevel(command.level);
            send(ws, { type: "response", id, command: command.type, success: true });
            send(ws, { type: "state", data: publicState(activeWorkspace, handle!.runtime.session) });
            break;
          case "extension_ui_response":
            if (!command.uiRequestId) throw new Error("Missing uiRequestId");
            pendingUi.get(command.uiRequestId)?.(command.value);
            pendingUi.delete(command.uiRequestId);
            send(ws, { type: "response", id, command: command.type, success: true });
            break;
          default:
            send(ws, { type: "response", id, command: command.type ?? "unknown", success: false, error: "Unknown command" });
        }
      } catch (error) {
        send(ws, {
          type: "response",
          id,
          command: command.type,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
        if (handle) send(ws, { type: "state", data: publicState(activeWorkspace, handle.runtime.session) });
      }
    });

    ws.on("close", async () => {
      unsubscribe?.();
      for (const resolve of pendingUi.values()) resolve(undefined);
      pendingUi.clear();
      await locks.release(handle?.runtime.session.sessionFile);
    });
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`piui listening on http://127.0.0.1:${port}`);
    console.log(`Piui WebSocket token: ${localToken}`);
    console.log(`Initial workspace: ${initialCwd}`);
    console.log(`Workspace registry: ${workspaceFile}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
