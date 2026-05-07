import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionCommandContextActions,
  type ExtensionUIContext,
  type SessionEntry,
  type ThemeColor,
  Theme,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  initTheme,
  getAgentDir,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { completeSimple, type Api, type Model } from "@mariozechner/pi-ai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? 5174);
const initialCwd = path.resolve(process.env.PIUI_CWD ?? process.cwd());
// Pi piui re-adds `initialCwd` on every startup, so the launch directory can
// never truly be removed from the sidebar — pinning it makes that explicit
// (no × on hover, server rejects remove_workspace for this id).
const initialWorkspaceId = crypto.createHash("sha1").update(initialCwd).digest("hex").slice(0, 12);
const agentDir = getAgentDir();
const workspaceFile = path.join(agentDir, "piui-workspaces.json");
const settingsFile = path.join(agentDir, "piui-settings.json");
const lockDir = path.join(agentDir, "piui-locks");
const localToken = process.env.PIUI_TOKEN ?? crypto.randomBytes(24).toString("base64url");

// Pop a native OS folder picker and resolve to an absolute path. Returns
// `null` if the user cancels. Currently macOS-only — Linux/Windows fall back
// to throwing so the client can surface a useful error.
function pickFolderNative(defaultPath: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (process.platform !== "darwin") {
      reject(new Error(`Native folder picker not supported on ${process.platform}; pass cwd explicitly.`));
      return;
    }
    const script = `try
  set theFolder to choose folder with prompt "Choose workspace folder" default location (POSIX file ${JSON.stringify(defaultPath)})
  return POSIX path of theFolder
on error number -128
  return ""
end try`;
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Folder picker failed (${code}): ${stderr.trim() || "unknown error"}`));
        return;
      }
      const picked = stdout.trim();
      if (!picked) { resolve(null); return; }
      // osascript appends a trailing slash; normalize.
      resolve(path.resolve(picked.replace(/\/$/, "")));
    });
  });
}

initTheme();
const themeColors: ThemeColor[] = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text", "thinkingText", "userMessageText", "customMessageText", "customMessageLabel", "toolTitle", "toolOutput", "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation", "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "bashMode",
];
const defaultExtensionTheme = new Theme(
  Object.fromEntries(themeColors.map((color) => [color, color === "error" ? "#dc2626" : color === "success" ? "#16a34a" : color === "warning" ? "#ca8a04" : "#6b7280"])) as Record<ThemeColor, string>,
  {
    selectedBg: "#f3f4f6",
    userMessageBg: "#f9fafb",
    customMessageBg: "#f9fafb",
    toolPendingBg: "#f3f4f6",
    toolSuccessBg: "#ecfdf5",
    toolErrorBg: "#fef2f2",
  },
  "truecolor",
  { name: "piui-web-fallback" },
);
const allowedOrigins = new Set(
  (process.env.PIUI_ORIGINS ?? `http://127.0.0.1:${port},http://localhost:${port}`)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const writeCommands = new Set<ClientCommand["type"]>([
  "open_workspace",
  "switch_workspace",
  "remove_workspace",
  "switch_session",
  "delete_session",
  "continue_recent",
  "new_session",
  "reload_resources",
  "invoke_command",
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "compact",
  "export_html",
  "fork",
  "clone",
  "set_session_name",
  "cycle_model",
  "set_model",
  "set_thinking_level",
  "set_settings",
  "extension_ui_response",
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
    | "delete_session"
    | "continue_recent"
    | "get_state"
    | "get_messages"
    | "get_resources"
    | "get_models"
    | "get_tree"
    | "reload_resources"
    | "invoke_command"
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
    | "get_settings"
    | "set_settings"
    | "extension_ui_response";
  cwd?: string;
  name?: string;
  workspaceId?: string;
  sessionPath?: string;
  entryId?: string;
  customInstructions?: string;
  commandName?: string;
  message?: string;
  streamingBehavior?: "steer" | "followUp";
  provider?: string;
  modelId?: string;
  level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  settings?: Partial<PiSettings>;
  uiRequestId?: string;
  value?: unknown;
};

type ModelRef = { provider: string; modelId: string };
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type PiSettings = {
  // null = "use the currently selected chat model".
  defaultModel: ModelRef | null;
  defaultThinkingLevel: ThinkingLevel | null;
  titleModel: ModelRef | null;
  showStarterPrompts: boolean;
};
const DEFAULT_SETTINGS: PiSettings = {
  defaultModel: null,
  defaultThinkingLevel: null,
  titleModel: null,
  showStarterPrompts: false,
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
  | { type: "settings"; data: unknown }
  | { type: "tree"; data: unknown }
  | { type: "extension_ui_request"; request: unknown }
  | { type: "extension_ui_status"; data: unknown }
  | { type: "notification"; data: { message: string; level?: "info" | "warning" | "error" } }
  | { type: "event"; event: unknown }
  | { type: "response"; id?: string; command: string; success: boolean; data?: unknown; error?: string };

function send(ws: WebSocket, packet: ServerPacket) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(packet));
}

function isAllowedHttpRequest(req: express.Request) {
  const host = req.hostname;
  const origin = req.get("origin");
  return (host === "127.0.0.1" || host === "localhost") && (!origin || allowedOrigins.has(origin));
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

class SettingsStore {
  private settings: PiSettings = { ...DEFAULT_SETTINGS };

  async load() {
    const data = await readJsonFile<Partial<PiSettings>>(settingsFile, {});
    this.settings = { ...DEFAULT_SETTINGS, ...data };
  }

  get(): PiSettings {
    return { ...this.settings };
  }

  async update(patch: Partial<PiSettings>): Promise<PiSettings> {
    this.settings = { ...this.settings, ...patch };
    await writeJsonFile(settingsFile, this.settings);
    return this.get();
  }
}

type SessionLock = {
  sessionFile: string;
  workspaceId: string;
  cwd: string;
  pid: number;
  token: string;
  ownerId: string;
  updatedAt: string;
};

class LockStore {
  async load() {
    await fs.mkdir(lockDir, { recursive: true });
  }

  private pathFor(sessionFile: string) {
    return path.join(lockDir, `${crypto.createHash("sha1").update(sessionFile).digest("hex")}.json`);
  }

  private async readLock(sessionFile: string) {
    return readJsonFile<SessionLock | null>(this.pathFor(sessionFile), null);
  }

  private isProcessAlive(pid: number) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async claim(sessionFile: string | undefined, workspace: Workspace, ownerId: string) {
    if (!sessionFile) return { owner: "none" as const };
    const lock: SessionLock = {
      sessionFile,
      workspaceId: workspace.id,
      cwd: workspace.cwd,
      pid: process.pid,
      token: localToken,
      ownerId,
      updatedAt: new Date().toISOString(),
    };
    const lockPath = this.pathFor(sessionFile);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    for (;;) {
      try {
        const file = await fs.open(lockPath, "wx");
        await file.writeFile(JSON.stringify(lock, null, 2));
        await file.close();
        return { owner: "self" as const, lock };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await this.readLock(sessionFile);
        if (!existing) continue;
        if (existing.token === localToken && existing.ownerId === ownerId) {
          await writeJsonFile(lockPath, { ...lock, updatedAt: new Date().toISOString() });
          return { owner: "self" as const, lock };
        }
        if (!this.isProcessAlive(existing.pid)) {
          await fs.unlink(lockPath).catch(() => undefined);
          continue;
        }
        return { owner: "other" as const, lock: existing };
      }
    }
  }

  async release(sessionFile: string | undefined, ownerId: string) {
    if (!sessionFile) return;
    const lockPath = this.pathFor(sessionFile);
    const existing = await this.readLock(sessionFile);
    if (existing?.token === localToken && existing.ownerId === ownerId) {
      await fs.unlink(lockPath).catch(() => undefined);
    }
  }
}

function lockConflictError(sessionFile: string, lock?: SessionLock) {
  const owner = lock ? ` by PID ${lock.pid}` : "";
  return new Error(`Session is already owned${owner}: ${sessionFile}. Switch to another session, clone it, or close the other runtime.`);
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

async function mostRecentSessionPath(cwd: string) {
  const sessions = await SessionManager.list(cwd);
  return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime())[0]?.path;
}

// Decorate persisted workspaces with a derived `pinned` flag for the wire so
// the client can hide the remove-X on the launch directory. We don't persist
// `pinned` because it's a function of `initialCwd` (which is per-process), so
// it'd go stale if the server is launched from a different cwd next time.
function publicWorkspaces(store: WorkspaceStore) {
  return store.list().map((workspace) => ({ ...workspace, pinned: workspace.id === initialWorkspaceId }));
}

// Pull the plain text out of an agent message's content, ignoring tool calls,
// thinking blocks, etc. Returns "" for nothing usable.
function plainTextFromMessage(message: { content: unknown } | undefined): string {
  if (!message) return "";
  const content = (message as { content: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: string; text?: string } => !!c && typeof c === "object" && (c as { type: string }).type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  }
  return "";
}

// Generate a short caption for the session by asking a model to summarize the
// first user prompt + the assistant's reply. Returns null if generation fails
// or the conversation isn't substantial enough yet.
async function generateSessionTitle(session: AgentSession, titleModelRef: ModelRef | null): Promise<string | null> {
  let model: Model<Api> | undefined;
  if (titleModelRef) model = session.modelRegistry.find(titleModelRef.provider, titleModelRef.modelId);
  if (!model) model = session.model as Model<Api> | undefined;
  if (!model) return null;

  const messages = session.messages ?? [];
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return null;
  const userText = plainTextFromMessage(firstUser as { content: unknown }).trim();
  if (!userText) return null;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const assistantText = plainTextFromMessage(lastAssistant as { content: unknown } | undefined).trim();

  const auth = await session.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return null;

  const prompt = `Write a short title (3–6 words) summarizing the topic of this conversation. Plain text only — no quotes, no trailing punctuation, no "Title:" prefix.\n\nUser said:\n${userText.slice(0, 1500)}\n\nAssistant replied:\n${assistantText.slice(0, 1200) || "(empty)"}\n\nTitle:`;

  try {
    const result = await completeSimple(
      model,
      { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: 32,
        // Title generation is a tiny labelling task — pay nothing for thinking.
        // The pi-ai impl accepts "minimal".."xhigh" in the type, but every
        // provider's implementation also honours "off" by skipping the
        // reasoning request entirely (see e.g. openai-codex-responses where a
        // clamped "off" produces undefined effort, and anthropic where any
        // falsy reasoning short-circuits to thinkingEnabled:false).
        reasoning: "off" as never,
      },
    );
    if (result.stopReason === "error" || result.stopReason === "aborted") return null;
    const title = result.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join(" ")
      .trim()
      // Strip surrounding quotes / asterisks / trailing punctuation that small
      // models sometimes ignore the instruction about.
      .replace(/^["'`*\s]+/, "")
      .replace(/[\s"'`*.,!?]+$/, "")
      // First line only — protects against models that try to elaborate.
      .split(/\r?\n/)[0]
      .trim();
    return title ? title.slice(0, 80) : null;
  } catch (error) {
    console.warn("Title generation failed:", error);
    return null;
  }
}

function publicResources(session: AgentSession) {
  const skills = session.resourceLoader.getSkills();
  const prompts = session.resourceLoader.getPrompts();
  const extensionCommands = session.extensionRunner.getRegisteredCommands().map((command) => ({
    name: command.invocationName,
    description: command.description,
    source: "extension",
  }));
  return {
    commands: [
      { name: "new", description: "Start a new session", source: "builtin" },
      { name: "resume", description: "Resume or switch sessions", source: "builtin" },
      { name: "clone", description: "Clone the current branch", source: "builtin" },
      { name: "compact", description: "Summarize older context", source: "builtin" },
      { name: "export", description: "Export session to HTML", source: "builtin" },
      { name: "reload", description: "Reload Pi resources", source: "builtin" },
      ...extensionCommands,
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

function waitForIdle(session: AgentSession) {
  if (!session.isStreaming && !session.isCompacting && !session.isRetrying) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_end" || event.type === "compaction_end") {
        if (!session.isStreaming && !session.isCompacting && !session.isRetrying) {
          unsubscribe();
          resolve();
        }
      }
    });
  });
}

function createCommandActions(handle: RuntimeHandle, locks: LockStore, ownerId: string): ExtensionCommandContextActions {
  return {
    waitForIdle: () => waitForIdle(handle.runtime.session),
    newSession: async (options) => {
      const previousSessionFile = handle.runtime.session.sessionFile;
      const result = await handle.runtime.newSession(options);
      if (!result.cancelled) await locks.release(previousSessionFile, ownerId);
      return result;
    },
    fork: async (entryId, options) => {
      const previousSessionFile = handle.runtime.session.sessionFile;
      const result = await handle.runtime.fork(entryId, options);
      if (!result.cancelled) await locks.release(previousSessionFile, ownerId);
      return { cancelled: result.cancelled };
    },
    navigateTree: async (targetId, options) => {
      const result = await handle.runtime.session.navigateTree(targetId, options);
      return { cancelled: result.cancelled };
    },
    switchSession: async (sessionPath, options) => {
      const lock = await locks.claim(sessionPath, handle.workspace, ownerId);
      if (lock.owner === "other") throw lockConflictError(sessionPath, lock.lock);
      const previousSessionFile = handle.runtime.session.sessionFile;
      const result = await handle.runtime.switchSession(sessionPath, options);
      if (!result.cancelled && previousSessionFile !== sessionPath) await locks.release(previousSessionFile, ownerId);
      else if (result.cancelled && previousSessionFile !== sessionPath) await locks.release(sessionPath, ownerId);
      return result;
    },
    reload: async () => {
      await handle.runtime.session.reload();
    },
  };
}

function createExtensionUI(ws: WebSocket, pendingUi: Map<string, (value: unknown) => void>): ExtensionUIContext {
  function request<T>(kind: string, payload: Record<string, unknown>, opts?: { signal?: AbortSignal; timeout?: number }) {
    const requestId = crypto.randomUUID();
    send(ws, { type: "extension_ui_request", request: { id: requestId, kind, ...payload } });
    return new Promise<T | undefined>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        opts?.signal?.removeEventListener("abort", abort);
        pendingUi.delete(requestId);
      };
      const finish = (value: unknown) => {
        cleanup();
        resolve(value as T | undefined);
      };
      const abort = () => finish(undefined);
      pendingUi.set(requestId, finish);
      timer = setTimeout(abort, opts?.timeout ?? 10 * 60 * 1000);
      timer.unref();
      opts?.signal?.addEventListener("abort", abort, { once: true });
    });
  }

  return {
    select: (title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }) => request<string>("select", { title, options, opts }, opts),
    confirm: async (title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }) => Boolean(await request<boolean>("confirm", { title, message, opts }, opts)),
    input: (title: string, placeholder?: string, opts?: { signal?: AbortSignal; timeout?: number }) => request<string>("input", { title, placeholder, opts }, opts),
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
    theme: defaultExtensionTheme,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Themes are managed by the browser UI." }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => undefined,
  } as unknown as ExtensionUIContext;
}

async function bindSession(ws: WebSocket, handle: RuntimeHandle, pendingUi: Map<string, (value: unknown) => void>, locks: LockStore, ownerId: string, settingsStore: SettingsStore, unsubscribe?: () => void) {
  unsubscribe?.();
  const session = handle.runtime.session;
  const lock = await locks.claim(session.sessionFile, handle.workspace, ownerId);
  if (lock.owner !== "other") {
    await session.bindExtensions({
      uiContext: createExtensionUI(ws, pendingUi),
      commandContextActions: createCommandActions(handle, locks, ownerId),
    });
  }
  // Track in-flight title generation per session-file so we don't fire the
  // model twice if `agent_end` lands while a previous request is still open.
  let titleInFlight = false;
  const nextUnsubscribe = session.subscribe((event) => {
    send(ws, { type: "event", event });
    if (["agent_start", "agent_end", "queue_update", "compaction_start", "compaction_end", "message_end", "tool_execution_end", "thinking_level_changed", "session_info_changed"].includes(event.type)) {
      send(ws, { type: "state", data: publicState(handle.workspace, session) });
    }
    if (event.type === "agent_end" && !titleInFlight && !session.sessionManager.getSessionName()) {
      titleInFlight = true;
      const ownedSessionFile = session.sessionFile;
      void (async () => {
        try {
          const title = await generateSessionTitle(session, settingsStore.get().titleModel);
          // Bail out if the user has switched away from this session before we got a result.
          if (!title || session.sessionFile !== ownedSessionFile || session.sessionManager.getSessionName()) return;
          session.setSessionName(title);
          send(ws, { type: "state", data: publicState(handle.workspace, session) });
          send(ws, { type: "sessions", data: { workspaceId: handle.workspace.id, sessions: await listSessions(handle.workspace.cwd) } });
        } finally {
          titleInFlight = false;
        }
      })();
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
  const settingsStore = new SettingsStore();
  await store.load();
  await locks.load();
  await settingsStore.load();

  const app = express();
  app.use(express.json());
  app.use("/api", (req, res, next) => {
    if (!isAllowedHttpRequest(req)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (req.method !== "GET" && req.get("x-piui-token") !== localToken && req.query.token !== localToken) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });
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

  app.get("/api/workspaces", (_req, res) => res.json({ workspaces: publicWorkspaces(store) }));
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
    const ownerId = crypto.randomUUID();
    const pendingUi = new Map<string, (value: unknown) => void>();

    async function applySessionDefaults(session: AgentSession) {
      const settings = settingsStore.get();
      if (settings.defaultModel) {
        const model = session.modelRegistry.find(settings.defaultModel.provider, settings.defaultModel.modelId);
        if (model) {
          try { await session.setModel(model); }
          catch (err) { console.warn("Failed to apply default model:", err); }
        }
      }
      if (settings.defaultThinkingLevel) {
        try { session.setThinkingLevel(settings.defaultThinkingLevel); }
        catch (err) { console.warn("Failed to apply default thinking level:", err); }
      }
    }

    async function activate(workspace: Workspace, options?: { mode?: "new" | "continue" | "open"; sessionPath?: string }) {
      if (handle?.runtime.session.sessionFile) await locks.release(handle.runtime.session.sessionFile, ownerId);
      await handle?.runtime.dispose();
      activeWorkspace = await store.touch(workspace.id);
      handle = { workspace: activeWorkspace, runtime: await createRuntimeFor(activeWorkspace.cwd, options?.mode, options?.sessionPath) };
      // Apply settings-driven defaults to brand-new sessions only — resuming an
      // existing session preserves whatever it was last using.
      if (options?.mode !== "open" && options?.mode !== "continue") await applySessionDefaults(handle.runtime.session);
      handle.runtime.setRebindSession(async () => {
        const binding = await bindSession(ws, handle!, pendingUi, locks, ownerId, settingsStore, unsubscribe);
        unsubscribe = binding.unsubscribe;
        readOnly = binding.readOnly;
        send(ws, { type: "workspaces", data: { workspaces: publicWorkspaces(store), activeWorkspaceId: activeWorkspace.id } });
      });
      const binding = await bindSession(ws, handle, pendingUi, locks, ownerId, settingsStore, unsubscribe);
      unsubscribe = binding.unsubscribe;
      readOnly = binding.readOnly;
      send(ws, { type: "workspaces", data: { workspaces: publicWorkspaces(store), activeWorkspaceId: activeWorkspace.id } });
      return handle;
    }

    try {
      await activate(activeWorkspace);
      send(ws, { type: "ready", data: { workspaces: publicWorkspaces(store), activeWorkspaceId: activeWorkspace.id, state: publicState(activeWorkspace, handle!.runtime.session), settings: settingsStore.get() } });
      send(ws, { type: "settings", data: settingsStore.get() });
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
          throw new Error("This session is read-only because another Pi runtime owns its session file. Close the other runtime before changing this session.");
        }
        switch (command.type) {
          case "list_workspaces":
            send(ws, { type: "response", id, command: command.type, success: true, data: { workspaces: publicWorkspaces(store), activeWorkspaceId: activeWorkspace.id } });
            send(ws, { type: "workspaces", data: { workspaces: publicWorkspaces(store), activeWorkspaceId: activeWorkspace.id } });
            break;
          case "open_workspace": {
            // No cwd supplied → pop a native folder picker. Cancel = no-op.
            let cwd = command.cwd;
            if (!cwd) {
              const picked = await pickFolderNative(activeWorkspace.cwd ?? initialCwd);
              if (!picked) {
                send(ws, { type: "response", id, command: command.type, success: true, data: { cancelled: true } });
                break;
              }
              cwd = picked;
            }
            const workspace = await store.add(cwd, command.name);
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
            if (command.workspaceId === initialWorkspaceId) {
              throw new Error("This workspace is the launch directory and is pinned — it can't be removed.");
            }
            if (command.workspaceId === activeWorkspace.id) await handle?.runtime.dispose();
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
          case "delete_session": {
            if (!command.sessionPath) throw new Error("Missing sessionPath");
            // Refuse to delete the session file we currently hold open.
            if (handle?.runtime.session.sessionFile === command.sessionPath) {
              throw new Error("This session is open. Switch to another conversation first, then delete it.");
            }
            // Don't allow deletion of files outside the active workspace's session listing.
            const sessionsForWs = await listSessions(activeWorkspace.cwd);
            if (!sessionsForWs.some((s) => s.path === command.sessionPath)) {
              throw new Error("Session not found in this workspace.");
            }
            await fs.unlink(command.sessionPath);
            send(ws, { type: "response", id, command: command.type, success: true });
            send(ws, { type: "sessions", data: { workspaceId: activeWorkspace.id, sessions: await listSessions(activeWorkspace.cwd) } });
            break;
          }
          case "switch_session":
            if (!command.sessionPath) throw new Error("Missing sessionPath");
            {
              const lock = await locks.claim(command.sessionPath, activeWorkspace, ownerId);
              if (lock.owner === "other") throw lockConflictError(command.sessionPath, lock.lock);
              const previousSessionFile = handle!.runtime.session.sessionFile;
              const result = await handle!.runtime.switchSession(command.sessionPath, { cwdOverride: activeWorkspace.cwd });
              if (!result.cancelled && previousSessionFile !== command.sessionPath) await locks.release(previousSessionFile, ownerId);
              else if (result.cancelled && previousSessionFile !== command.sessionPath) await locks.release(command.sessionPath, ownerId);
              send(ws, { type: "response", id, command: command.type, success: !result.cancelled, data: result, error: result.cancelled ? "Session switch cancelled by extension." : undefined });
            }
            break;
          case "continue_recent":
            {
              const sessionPath = await mostRecentSessionPath(activeWorkspace.cwd);
              if (sessionPath) {
                const lock = await locks.claim(sessionPath, activeWorkspace, ownerId);
                if (lock.owner === "other") throw lockConflictError(sessionPath, lock.lock);
                const previousSessionFile = handle!.runtime.session.sessionFile;
                const result = await handle!.runtime.switchSession(sessionPath, { cwdOverride: activeWorkspace.cwd });
                if (!result.cancelled && previousSessionFile !== sessionPath) await locks.release(previousSessionFile, ownerId);
                else if (result.cancelled && previousSessionFile !== sessionPath) await locks.release(sessionPath, ownerId);
                send(ws, { type: "response", id, command: command.type, success: !result.cancelled, data: result, error: result.cancelled ? "Session switch cancelled by extension." : undefined });
              } else {
                const previousSessionFile = handle!.runtime.session.sessionFile;
                const result = await handle!.runtime.newSession();
                if (!result.cancelled) await locks.release(previousSessionFile, ownerId);
                send(ws, { type: "response", id, command: command.type, success: !result.cancelled, data: result, error: result.cancelled ? "New session cancelled by extension." : undefined });
              }
            }
            break;
          case "new_session":
            const previousSessionFile = handle!.runtime.session.sessionFile;
            const newSessionResult = await handle!.runtime.newSession();
            if (!newSessionResult.cancelled) await locks.release(previousSessionFile, ownerId);
            send(ws, { type: "response", id, command: command.type, success: !newSessionResult.cancelled, data: newSessionResult, error: newSessionResult.cancelled ? "New session cancelled by extension." : undefined });
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
          case "reload_resources":
            await handle!.runtime.session.reload();
            send(ws, { type: "response", id, command: command.type, success: true });
            send(ws, { type: "resources", data: publicResources(handle!.runtime.session) });
            break;
          case "invoke_command": {
            if (!command.commandName) throw new Error("Missing commandName");
            const name = command.commandName.replace(/^\//, "");
            if (name === "new") {
              const previous = handle!.runtime.session.sessionFile;
              const result = await handle!.runtime.newSession();
              if (!result.cancelled) await locks.release(previous, ownerId);
            } else if (name === "resume") {
              const sessionPath = await mostRecentSessionPath(activeWorkspace.cwd);
              if (sessionPath) {
                const lock = await locks.claim(sessionPath, activeWorkspace, ownerId);
                if (lock.owner === "other") throw lockConflictError(sessionPath, lock.lock);
                const previous = handle!.runtime.session.sessionFile;
                const result = await handle!.runtime.switchSession(sessionPath, { cwdOverride: activeWorkspace.cwd });
                if (!result.cancelled && previous !== sessionPath) await locks.release(previous, ownerId);
                else if (result.cancelled && previous !== sessionPath) await locks.release(sessionPath, ownerId);
              }
            } else if (name === "clone") {
              const leafId = handle!.runtime.session.sessionManager.getLeafId();
              if (leafId) {
                const previous = handle!.runtime.session.sessionFile;
                const result = await handle!.runtime.fork(leafId, { position: "at" });
                if (!result.cancelled) await locks.release(previous, ownerId);
              }
            } else if (name === "compact") await handle!.runtime.session.compact();
            else if (name === "export") await handle!.runtime.session.exportToHtml();
            else if (name === "reload") await handle!.runtime.session.reload();
            else await handle!.runtime.session.prompt(`/${name}`);
            send(ws, { type: "response", id, command: command.type, success: true });
            send(ws, { type: "state", data: publicState(activeWorkspace, handle!.runtime.session) });
            send(ws, { type: "resources", data: publicResources(handle!.runtime.session) });
            break;
          }
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
            const forkResult = await handle!.runtime.fork(command.entryId, { position: "before" });
            if (!forkResult.cancelled) await locks.release(previousForkSessionFile, ownerId);
            send(ws, { type: "response", id, command: command.type, success: !forkResult.cancelled, data: { cancelled: forkResult.cancelled, selectedText: forkResult.selectedText }, error: forkResult.cancelled ? "Fork cancelled by extension." : undefined });
            break;
          case "clone": {
            const leafId = handle!.runtime.session.sessionManager.getLeafId();
            if (!leafId) throw new Error("No current session entry to clone");
            const previousCloneSessionFile = handle!.runtime.session.sessionFile;
            const cloneResult = await handle!.runtime.fork(leafId, { position: "at" });
            if (!cloneResult.cancelled) await locks.release(previousCloneSessionFile, ownerId);
            send(ws, { type: "response", id, command: command.type, success: !cloneResult.cancelled, data: cloneResult, error: cloneResult.cancelled ? "Clone cancelled by extension." : undefined });
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
          case "get_settings":
            send(ws, { type: "response", id, command: command.type, success: true, data: settingsStore.get() });
            send(ws, { type: "settings", data: settingsStore.get() });
            break;
          case "set_settings": {
            const next = await settingsStore.update(command.settings ?? {});
            send(ws, { type: "response", id, command: command.type, success: true, data: next });
            send(ws, { type: "settings", data: next });
            break;
          }
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
      await locks.release(handle?.runtime.session.sessionFile, ownerId);
      await handle?.runtime.dispose();
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
