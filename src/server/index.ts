import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
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
    | "prompt"
    | "steer"
    | "follow_up"
    | "abort"
    | "new_session"
    | "cycle_model"
    | "set_thinking_level";
  cwd?: string;
  name?: string;
  workspaceId?: string;
  sessionPath?: string;
  message?: string;
  streamingBehavior?: "steer" | "followUp";
  level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
};

type ServerPacket =
  | { type: "ready"; data: unknown }
  | { type: "workspaces"; data: unknown }
  | { type: "workspace"; data: unknown }
  | { type: "sessions"; data: unknown }
  | { type: "state"; data: unknown }
  | { type: "messages"; data: unknown }
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

class WorkspaceStore {
  private workspaces = new Map<string, Workspace>();

  async load() {
    await fs.mkdir(path.dirname(workspaceFile), { recursive: true });
    try {
      const raw = await fs.readFile(workspaceFile, "utf8");
      const data = JSON.parse(raw) as { workspaces?: Workspace[] };
      for (const workspace of data.workspaces ?? []) this.workspaces.set(workspace.id, workspace);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`Could not load ${workspaceFile}:`, error);
    }
    await this.add(initialCwd);
  }

  list() {
    return [...this.workspaces.values()].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  }

  get(id: string) {
    return this.workspaces.get(id);
  }

  async add(cwdInput: string, name?: string) {
    const cwd = path.resolve(cwdInput.replace(/^~/, process.env.HOME ?? "~"));
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
    await fs.writeFile(workspaceFile, JSON.stringify({ workspaces: this.list() }, null, 2));
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

async function bindSession(ws: WebSocket, handle: RuntimeHandle, unsubscribe?: () => void) {
  unsubscribe?.();
  const session = handle.runtime.session;
  await (session as AgentSession & { bindExtensions?: (options: Record<string, never>) => Promise<void> }).bindExtensions?.({});
  const nextUnsubscribe = session.subscribe((event) => {
    send(ws, { type: "event", event });
    if (["agent_end", "queue_update", "compaction_end", "message_end", "tool_execution_end"].includes(event.type)) {
      send(ws, { type: "state", data: publicState(handle.workspace, session) });
    }
  });
  send(ws, { type: "workspace", data: handle.workspace });
  send(ws, { type: "state", data: publicState(handle.workspace, session) });
  send(ws, { type: "messages", data: { messages: session.messages } });
  send(ws, { type: "sessions", data: { workspaceId: handle.workspace.id, sessions: await listSessions(handle.workspace.cwd) } });
  return nextUnsubscribe;
}

async function main() {
  const store = new WorkspaceStore();
  await store.load();
  const runtimes = new RuntimeManager();

  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, cwd: initialCwd, mode: isProduction ? "production" : "development", workspaces: store.list().length });
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

    async function activate(workspace: Workspace, options?: { mode?: "new" | "continue" | "open"; sessionPath?: string }) {
      activeWorkspace = await store.touch(workspace.id);
      handle = options?.mode ? await runtimes.recreate(activeWorkspace, options.mode, options.sessionPath) : await runtimes.get(activeWorkspace);
      unsubscribe = await bindSession(ws, handle, unsubscribe);
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
            await handle!.runtime.newSession();
            unsubscribe = await bindSession(ws, handle!, unsubscribe);
            send(ws, { type: "response", id, command: command.type, success: true });
            break;
          case "get_state":
            send(ws, { type: "response", id, command: command.type, success: true, data: publicState(activeWorkspace, handle!.runtime.session) });
            break;
          case "get_messages":
            send(ws, { type: "response", id, command: command.type, success: true, data: { messages: handle!.runtime.session.messages } });
            break;
          case "prompt": {
            const session = handle!.runtime.session;
            if (!command.message?.trim()) throw new Error("Missing message");
            send(ws, { type: "response", id, command: command.type, success: true });
            await session.prompt(command.message, { streamingBehavior: command.streamingBehavior });
            send(ws, { type: "state", data: publicState(activeWorkspace, session) });
            send(ws, { type: "sessions", data: { workspaceId: activeWorkspace.id, sessions: await listSessions(activeWorkspace.cwd) } });
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
          case "cycle_model": {
            const result = await handle!.runtime.session.cycleModel();
            send(ws, { type: "response", id, command: command.type, success: true, data: result });
            send(ws, { type: "state", data: publicState(activeWorkspace, handle!.runtime.session) });
            break;
          }
          case "set_thinking_level":
            if (!command.level) throw new Error("Missing thinking level");
            handle!.runtime.session.setThinkingLevel(command.level);
            send(ws, { type: "response", id, command: command.type, success: true });
            send(ws, { type: "state", data: publicState(activeWorkspace, handle!.runtime.session) });
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

    ws.on("close", () => unsubscribe?.());
  });

  server.listen(port, () => {
    console.log(`piui listening on http://localhost:${port}`);
    console.log(`Initial workspace: ${initialCwd}`);
    console.log(`Workspace registry: ${workspaceFile}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
