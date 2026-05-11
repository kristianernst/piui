import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
// Sync filesystem helpers — used at startup for editor detection and icon
// extraction. Kept under a distinct namespace so the `fs` async API stays
// the default everywhere else.
import * as fsSync from "node:fs";
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
import { WidgetHost, OVERLAY_SLOT } from "./tui-shim.js";

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

// Editor opener — open a workspace file in an installed editor. Detection
// can't lean on `process.env.PATH` alone: when piui is spawned from a GUI
// context (Claude Code, launchd, etc.) the inherited PATH is the stripped-down
// system one and misses `/usr/local/bin`, `/opt/homebrew/bin`, the codeium
// install dir, etc. Instead we probe a candidate list of well-known absolute
// paths AND the macOS `/Applications/*.app` bundles, falling back to launching
// via `open -a "<App>"` when only the .app exists (no CLI shim installed).
type EditorEntry = {
  id: string;
  label: string;
  // List of likely CLI binary locations. First hit wins; if none match we
  // fall back to the .app bundle if available.
  cliCandidates: string[];
  // macOS .app bundle name (sans the `.app` suffix). Looked up under both
  // `/Applications` and `~/Applications`. Use undefined to skip.
  appName?: string;
  // Fixed-args strategy for the CLI (most editors just want a path).
  cliArgs?: (absPath: string) => string[];
};

const HOME = os.homedir();
const EDITOR_CATALOG: EditorEntry[] = [
  {
    id: "cursor",
    label: "Cursor",
    cliCandidates: ["/usr/local/bin/cursor", "/opt/homebrew/bin/cursor", `${HOME}/.local/bin/cursor`],
    appName: "Cursor",
  },
  {
    id: "vscode",
    label: "VS Code",
    cliCandidates: [
      "/usr/local/bin/code",
      "/opt/homebrew/bin/code",
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    ],
    appName: "Visual Studio Code",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    cliCandidates: [
      "/usr/local/bin/windsurf",
      "/opt/homebrew/bin/windsurf",
      `${HOME}/.codeium/windsurf/bin/windsurf`,
    ],
    appName: "Windsurf",
  },
  {
    id: "zed",
    label: "Zed",
    cliCandidates: [
      "/usr/local/bin/zed",
      "/opt/homebrew/bin/zed",
      `${HOME}/.local/bin/zed`,
    ],
    appName: "Zed",
  },
];

function existsAsFile(p: string): boolean {
  try { return fsSync.statSync(p).isFile(); } catch { return false; }
}
function existsAsDir(p: string): boolean {
  try { return fsSync.statSync(p).isDirectory(); } catch { return false; }
}

// Walk a candidate list — returns the first absolute path that exists as a
// regular file. Symlinks resolve through statSync to their targets.
function locateCli(candidates: string[]): string | null {
  for (const c of candidates) {
    if (existsAsFile(c)) return c;
  }
  return null;
}

// Look in the standard macOS app roots for `<appName>.app`. Returns the
// absolute path to the bundle (a directory) or null.
function locateApp(appName: string): string | null {
  if (process.platform !== "darwin") return null;
  for (const root of ["/Applications", `${HOME}/Applications`]) {
    const candidate = `${root}/${appName}.app`;
    if (existsAsDir(candidate)) return candidate;
  }
  return null;
}

// Resolved opener: either spawn the CLI directly or fall back to `open -a`
// on macOS using the discovered .app bundle. Stored at module scope so the
// `open_in_editor` command handler can look up by id in O(1).
type ResolvedOpener = { command: string; args: (absPath: string) => string[] };
const resolvedOpeners = new Map<string, ResolvedOpener>();
// Disk-cached PNG icons keyed by editor id. Extracted once at startup from
// the .app bundle's CFBundleIconFile via `plutil` + `sips`, then served by
// the daemon as `/api/editor-icon/:id`. Skipped silently when the helpers
// aren't available (non-macOS, missing binaries) — the client falls back to
// its generic glyph in that case.
const editorIcons = new Map<string, string>();
const iconCacheDir = path.join(agentDir, "piui-editor-icons");
try { fsSync.mkdirSync(iconCacheDir, { recursive: true }); } catch { /* best-effort */ }

function extractAppIcon(appPath: string, editorId: string): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const plist = path.join(appPath, "Contents/Info.plist");
    const probe = spawnSync("plutil", ["-extract", "CFBundleIconFile", "raw", plist], { encoding: "utf-8" });
    if (probe.status !== 0) return null;
    let iconName = probe.stdout.trim();
    if (!iconName) return null;
    if (!iconName.toLowerCase().endsWith(".icns")) iconName += ".icns";
    const icnsPath = path.join(appPath, "Contents/Resources", iconName);
    if (!existsAsFile(icnsPath)) return null;
    const outPath = path.join(iconCacheDir, `${editorId}.png`);
    // Cache-busting key: source mtime. If the .app was upgraded since last
    // boot we want a fresh icon, not yesterday's. Compare via stat.
    const srcMtime = fsSync.statSync(icnsPath).mtimeMs;
    if (existsAsFile(outPath) && fsSync.statSync(outPath).mtimeMs > srcMtime) return outPath;
    // 64px is comfortable for a 16-22px button at 2× DPR; sips rasterizes
    // the best-matching size from the multi-image .icns container.
    const conv = spawnSync("sips", ["-s", "format", "png", icnsPath, "--out", outPath, "-Z", "64"], { encoding: "utf-8" });
    if (conv.status !== 0) return null;
    return outPath;
  } catch {
    return null;
  }
}

function registerEditor(id: string, label: string, opener: ResolvedOpener, iconSource: string | null) {
  resolvedOpeners.set(id, opener);
  const icon = iconSource ? extractAppIcon(iconSource, id) : null;
  if (icon) editorIcons.set(id, icon);
  return { id, label, hasIcon: !!icon };
}

const availableEditors: Array<{ id: string; label: string; hasIcon: boolean }> = (() => {
  const out: Array<{ id: string; label: string; hasIcon: boolean }> = [];
  for (const entry of EDITOR_CATALOG) {
    const cli = locateCli(entry.cliCandidates);
    const app = entry.appName ? locateApp(entry.appName) : null;
    if (cli) {
      const argsFn = entry.cliArgs ?? ((p: string) => [p]);
      out.push(registerEditor(entry.id, entry.label, { command: cli, args: argsFn }, app));
      continue;
    }
    if (app && entry.appName) {
      // `open -a "AppName" <file>` works for any registered .app whether
      // or not the CLI shim is installed. We deliberately don't pass `-g`
      // so the editor comes to the foreground.
      const appName = entry.appName;
      out.push(registerEditor(entry.id, entry.label, {
        command: "open",
        args: (p: string) => ["-a", appName, p],
      }, app));
    }
  }
  // macOS Finder reveal — always available via the built-in `open` binary;
  // -R highlights the file in its containing folder rather than launching
  // it with the default app. Pull the icon from the system Finder.app.
  if (process.platform === "darwin") {
    out.push(registerEditor("finder", "Finder",
      { command: "open", args: (p: string) => ["-R", p] },
      "/System/Library/CoreServices/Finder.app",
    ));
  }
  return out;
})();

function openInEditor(editorId: string, absPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const opener = resolvedOpeners.get(editorId);
    if (!opener) { reject(new Error(`Unknown editor: ${editorId}`)); return; }
    const child = spawn(opener.command, opener.args(absPath), { stdio: "ignore", detached: true });
    child.on("error", reject);
    // Detach immediately — we don't want the agent server to babysit a GUI
    // editor's lifecycle. `unref` lets node exit independently.
    child.unref();
    resolve();
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
  "trigger_shortcut",
  "extension_input",
  "open_in_editor",
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
    | "list_files"
    | "get_git"
    | "extension_ui_response"
    | "trigger_shortcut"
    | "extension_input"
    | "open_in_editor";
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
  key?: string;
  data?: string;
  editor?: string;
  path?: string;
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
  | { type: "git"; data: unknown }
  | { type: "files"; data: unknown }
  | { type: "tree"; data: unknown }
  | { type: "extension_ui_request"; request: unknown }
  | { type: "extension_ui_status"; data: unknown }
  | { type: "extension_ui_widget"; data: { slot: string; lines?: string[]; removed?: true } }
  | { type: "extension_reset" }
  | { type: "shortcuts"; data: { shortcuts: Array<{ key: string; description?: string }> } }
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
    return [...this.workspaces.values()];
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

function sessionIsRunning(session: AgentSession) {
  return session.isStreaming || session.isCompacting || session.isRetrying;
}

async function listSessions(cwd: string, liveSessions: AgentSession[] = []) {
  const sessions = await SessionManager.list(cwd);
  return sessions.slice(0, 50).map((session) => {
    const liveSession = liveSessions.find((candidate) => candidate.sessionFile === session.path);
    return {
      path: session.path,
      id: session.id,
      cwd: session.cwd,
      name: session.name,
      created: session.created,
      modified: session.modified,
      messageCount: session.messageCount,
      firstMessage: session.firstMessage,
      liveSessionId: liveSession?.sessionId,
      isRunning: liveSession ? sessionIsRunning(liveSession) : undefined,
    };
  });
}

function workspaceFromCommand(store: WorkspaceStore, activeWorkspace: Workspace, workspaceId?: string) {
  if (!workspaceId) return activeWorkspace;
  const workspace = store.get(workspaceId);
  if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
  return workspace;
}

async function mostRecentSessionPath(cwd: string) {
  const sessions = await SessionManager.list(cwd);
  return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime())[0]?.path;
}

const FILE_LIST_LIMIT = 4000;
const GIT_DIFF_LIMIT = 220_000;
const FILE_WALK_EXCLUDE = new Set([
  ".git", "node_modules", "dist", "build", "out", ".next", ".vite",
  ".turbo", ".cache", ".venv", "venv", "__pycache__", ".mypy_cache",
  ".pytest_cache", ".idea", ".vscode", "coverage", ".nyc_output",
]);

// List workspace-relative file paths for `@`-mention autocomplete. Fast-path
// is `git ls-files` (already gitignore-aware); falls back to a bounded
// recursive walk that skips common heavy directories. Capped at FILE_LIST_LIMIT
// so a monorepo doesn't ship a giant payload over the wire.
function runGit(cwd: string, args: string[], opts: { maxBytes?: number } = {}): Promise<{ stdout: string; stderr: string; code: number; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const maxBytes = opts.maxBytes ?? 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let truncated = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= maxBytes) { truncated = true; return; }
      const remaining = maxBytes - stdoutBytes;
      stdout += chunk.subarray(0, remaining).toString();
      stdoutBytes += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) truncated = true;
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0, truncated }));
  });
}

async function gitText(cwd: string, args: string[], opts?: { maxBytes?: number }) {
  const result = await runGit(cwd, args, opts);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} exited ${result.code}`);
  return result;
}

type GitFileStatus = {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "copied" | "typechange" | "unknown";
  index: string;
  worktree: string;
};

type GitSnapshot = {
  isRepo: boolean;
  root?: string;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  clean?: boolean;
  files: GitFileStatus[];
  diff?: string;
  diffTruncated?: boolean;
  error?: string;
};

function statusFromXY(index: string, worktree: string): GitFileStatus["status"] {
  if (index === "?" && worktree === "?") return "untracked";
  if (index === "R" || worktree === "R") return "renamed";
  if (index === "C" || worktree === "C") return "copied";
  if (index === "A" || worktree === "A") return "added";
  if (index === "D" || worktree === "D") return "deleted";
  if (index === "T" || worktree === "T") return "typechange";
  if (index === "M" || worktree === "M") return "modified";
  return "unknown";
}

function parseGitStatus(output: string): GitFileStatus[] {
  const entries = output.split("\0").filter(Boolean);
  const files: GitFileStatus[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const index = entry[0] ?? " ";
    const worktree = entry[1] ?? " ";
    const path = entry.slice(3);
    const status = statusFromXY(index, worktree);
    const file: GitFileStatus = { path, status, index, worktree };
    if ((index === "R" || index === "C") && entries[i + 1]) file.oldPath = entries[++i];
    files.push(file);
  }
  return files;
}

async function gitSnapshot(cwd: string): Promise<GitSnapshot> {
  try {
    const root = (await gitText(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
    const branch = (await gitText(cwd, ["branch", "--show-current"])).stdout.trim()
      || (await gitText(cwd, ["rev-parse", "--short", "HEAD"])).stdout.trim();
    const statusOut = await gitText(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
    const files = parseGitStatus(statusOut.stdout);

    let upstream: string | undefined;
    let ahead = 0;
    let behind = 0;
    try {
      upstream = (await gitText(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).stdout.trim() || undefined;
      const counts = (await gitText(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{u}"])).stdout.trim().split(/\s+/).map(Number);
      ahead = Number.isFinite(counts[0]) ? counts[0] : 0;
      behind = Number.isFinite(counts[1]) ? counts[1] : 0;
    } catch {
      // No upstream configured — local branch name is still useful.
    }

    const staged = await gitText(cwd, ["diff", "--cached", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"], { maxBytes: GIT_DIFF_LIMIT });
    const remaining = Math.max(0, GIT_DIFF_LIMIT - Buffer.byteLength(staged.stdout));
    const unstaged = remaining > 0
      ? await gitText(cwd, ["diff", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"], { maxBytes: remaining })
      : { stdout: "", truncated: true };
    const chunks = [staged.stdout.trimEnd(), unstaged.stdout.trimEnd()].filter(Boolean);
    return {
      isRepo: true,
      root,
      branch,
      upstream,
      ahead,
      behind,
      clean: files.length === 0,
      files,
      diff: chunks.join("\n\n"),
      diffTruncated: staged.truncated || unstaged.truncated,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not a git repository/i.test(message)) return { isRepo: false, files: [] };
    return { isRepo: false, files: [], error: message };
  }
}

async function listWorkspaceFiles(cwd: string): Promise<string[]> {
  // Prefer git when the workspace is a checkout — it respects .gitignore and
  // is dramatically faster on large repos.
  try {
    const out = await new Promise<string>((resolve, reject) => {
      runGit(cwd, ["ls-files", "--cached", "--others", "--exclude-standard"])
        .then((result) => result.code === 0 ? resolve(result.stdout) : reject(new Error(result.stderr.trim() || `git ls-files exited ${result.code}`)))
        .catch(reject);
    });
    const files = out.split("\n").filter(Boolean).slice(0, FILE_LIST_LIMIT);
    if (files.length) return files;
  } catch {
    // Not a git repo (or git missing) — fall through to manual walk.
  }
  const collected: string[] = [];
  async function walk(dir: string, depth: number) {
    if (collected.length >= FILE_LIST_LIMIT || depth > 8) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (collected.length >= FILE_LIST_LIMIT) return;
      if (entry.name.startsWith(".") && entry.name !== ".env" && entry.name !== ".env.example") continue;
      if (FILE_WALK_EXCLUDE.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        collected.push(path.relative(cwd, full));
      }
    }
  }
  await walk(cwd, 0);
  return collected;
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

function createExtensionUI(ws: WebSocket, pendingUi: Map<string, (value: unknown) => void>, widgetHost: WidgetHost): ExtensionUIContext {
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

  // Reused by setWidget/setHeader/setFooter — Pi's contract accepts either a
  // string[] (raw terminal lines) or a `(tui, theme) => Component` factory.
  // We funnel both into the WidgetHost; passing `undefined` clears the slot.
  function setSlot(slot: string, content: unknown, theme: Theme): void {
    if (content == null) {
      widgetHost.clear(slot);
      return;
    }
    if (typeof content === "function") {
      widgetHost.setFactory(slot, content as (tui: unknown, theme: Theme) => { render(width: number): string[] }, theme);
      return;
    }
    if (Array.isArray(content)) {
      widgetHost.setLines(slot, content.filter((line): line is string => typeof line === "string"));
      return;
    }
    // Unknown shape — drop it rather than crash.
    console.warn(`[piui] setWidget for slot ${slot} got unsupported content type: ${typeof content}`);
    widgetHost.clear(slot);
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
    setWidget: (key: string, content: unknown) => setSlot(`widget:${key}`, content, defaultExtensionTheme),
    setFooter: (factory: unknown) => setSlot("footer", factory, defaultExtensionTheme),
    setHeader: (factory: unknown) => setSlot("header", factory, defaultExtensionTheme),
    setTitle: (title: string) => send(ws, { type: "extension_ui_status", data: { key: "title", text: title } }),
    // Open a focused, scrollable overlay. The extension's factory returns a
    // Component with optional `handleInput` — keystrokes captured client-side
    // are forwarded back through `extension_input` and dispatched here.
    custom: async <T,>(factory: unknown) => {
      if (typeof factory !== "function") return undefined as T;
      const result = await widgetHost.setOverlay(factory as Parameters<WidgetHost["setOverlay"]>[0], defaultExtensionTheme);
      return result as T;
    },
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

// Pi extension shortcuts are KeyId strings like "ctrl+shift+t" with modifiers
// in any order. We canonicalize to a fixed modifier order [ctrl, shift, alt,
// super] so server-side lookup matches whatever the client emits, regardless
// of how the extension author wrote it.
function canonicalKeyId(key: string): string {
  const parts = key.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  const order = ["ctrl", "shift", "alt", "super"];
  const base = parts[parts.length - 1];
  const mods = parts.slice(0, -1).filter((m) => order.includes(m));
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  // Drop duplicates while preserving order.
  const dedup = mods.filter((m, i) => mods.indexOf(m) === i);
  return [...dedup, base].join("+");
}

function listExtensionShortcuts(handle: RuntimeHandle): Array<{ key: string; description?: string }> {
  try {
    const shortcuts = handle.runtime.session.extensionRunner.getShortcuts({});
    return [...shortcuts].map(([key, sc]) => ({ key: canonicalKeyId(key), description: sc.description }));
  } catch (error) {
    console.warn("Failed to enumerate extension shortcuts:", error);
    return [];
  }
}

// Build the minimum-viable ExtensionContext that an extension's shortcut /
// event handler expects. Pi's interactive mode constructs a richer one with
// access to streaming internals; piui exposes the public AgentSession API.
// Most handlers (autoresearch's toggle dashboard, etc.) only touch ctx.cwd
// and ctx.ui, so this lightweight context is enough in practice.
function buildExtensionContext(handle: RuntimeHandle, ui: ExtensionUIContext) {
  const session = handle.runtime.session;
  return {
    ui,
    hasUI: true,
    cwd: handle.workspace.cwd,
    sessionManager: session.sessionManager,
    modelRegistry: session.modelRegistry,
    model: session.model,
    isIdle: () => !session.isStreaming,
    signal: undefined,
    abort: () => session.abort(),
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: (opts?: { customInstructions?: string }) => { void session.compact(opts?.customInstructions); },
    getSystemPrompt: () => "",
  };
}

async function bindSession(ws: WebSocket, handle: RuntimeHandle, pendingUi: Map<string, (value: unknown) => void>, widgetHost: WidgetHost, uiContext: ExtensionUIContext, locks: LockStore, ownerId: string, settingsStore: SettingsStore, unsubscribe?: () => void, isCurrent: () => boolean = () => true) {
  unsubscribe?.();
  const session = handle.runtime.session;
  const lock = await locks.claim(session.sessionFile, handle.workspace, ownerId);
  if (lock.owner !== "other") {
    // Wipe any widgets the previous session's extensions registered before we
    // bind the new one — extension factories will re-register from scratch.
    widgetHost.reset();
    // Tell the client to clear residual extension status/title/working-message
    // fields too. Slots are removed via widgetHost.reset() above, but the
    // chrome state lives only on the client and needs an explicit reset so it
    // doesn't bleed from one conversation into the next.
    send(ws, { type: "extension_reset" });
    await session.bindExtensions({
      uiContext,
      commandContextActions: createCommandActions(handle, locks, ownerId),
    });
    // Once extensions have re-registered, push their shortcut list down to the
    // browser so it can capture matching keys and forward them to us.
    send(ws, { type: "shortcuts", data: { shortcuts: listExtensionShortcuts(handle) } });
  }
  // Track in-flight title generation per session-file so we don't fire the
  // model twice if `agent_end` lands while a previous request is still open.
  let titleInFlight = false;
  const nextUnsubscribe = session.subscribe((event) => {
    if (!isCurrent()) return;
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
          if (!isCurrent() || !title || session.sessionFile !== ownedSessionFile || session.sessionManager.getSessionName()) return;
          session.setSessionName(title);
          send(ws, { type: "state", data: publicState(handle.workspace, session) });
          send(ws, { type: "sessions", data: { workspaceId: handle.workspace.id, sessions: await listSessions(handle.workspace.cwd, [session]) } });
        } finally {
          titleInFlight = false;
        }
      })();
    }
  });
  send(ws, { type: "workspace", data: handle.workspace });
  send(ws, { type: "state", data: publicState(handle.workspace, session) });
  send(ws, { type: "messages", data: { messages: session.messages } });
  send(ws, { type: "sessions", data: { workspaceId: handle.workspace.id, sessions: await listSessions(handle.workspace.cwd, [session]) } });
  send(ws, { type: "resources", data: publicResources(session) });
  send(ws, { type: "models", data: { models: publicModels(session) } });
  send(ws, { type: "tree", data: { entries: publicTree(session) } });
  send(ws, { type: "git", data: await gitSnapshot(handle.workspace.cwd) });
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

  // Serve the editor icons extracted from each detected `.app`'s
  // CFBundleIconFile. Keyed by editor id; 404 when an icon couldn't be
  // extracted (the client falls back to its generic IconCode glyph).
  app.get("/api/editor-icon/:id", (req, res) => {
    const file = editorIcons.get(req.params.id);
    if (!file) { res.status(404).end(); return; }
    // Long max-age + immutable; the cache key changes when the .app is
    // upgraded because the source mtime triggers re-extraction at boot.
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(file);
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
    const handles = new Map<string, RuntimeHandle>();
    const activeHandleByWorkspace = new Map<string, RuntimeHandle>();
    const statusUnsubscribes = new Map<string, () => void>();
    const ownerId = crypto.randomUUID();
    const pendingUi = new Map<string, (value: unknown) => void>();
    // One WidgetHost per WS connection; it's reset between sessions so a new
    // session's extensions start with an empty slot table. The host emits
    // ANSI lines straight to this socket whenever a registered Component
    // requests a re-render.
    const widgetHost = new WidgetHost({
      emit: (slot, lines) => send(ws, { type: "extension_ui_widget", data: { slot, lines } }),
      remove: (slot) => send(ws, { type: "extension_ui_widget", data: { slot, removed: true } }),
    });
    // The uiContext lives at WS-connection scope: all session binds and any
    // shortcut-handler invocations share the same one, so when an extension
    // calls ctx.ui.setWidget from a shortcut it routes back through this WS.
    const extensionUi = createExtensionUI(ws, pendingUi, widgetHost);

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

    function handleKey(workspaceId: string, sessionFile?: string) {
      return `${workspaceId}:${sessionFile ?? "new"}`;
    }

    function keyForHandle(next: RuntimeHandle) {
      return handleKey(next.workspace.id, next.runtime.session.sessionFile);
    }

    function handlesForWorkspace(workspaceId: string) {
      return [...handles.values()].filter((candidate) => candidate.workspace.id === workspaceId);
    }

    function liveSessionsFor(workspaceId: string) {
      return handlesForWorkspace(workspaceId).map((candidate) => candidate.runtime.session);
    }

    function registerHandle(next: RuntimeHandle) {
      const nextKey = keyForHandle(next);
      for (const [key, candidate] of handles) {
        if (candidate === next && key !== nextKey) {
          handles.delete(key);
          statusUnsubscribes.get(key)?.();
          statusUnsubscribes.delete(key);
        }
      }
      handles.set(nextKey, next);
      activeHandleByWorkspace.set(next.workspace.id, next);
    }

    async function sendWorkspaceSessions(workspace: Workspace) {
      send(ws, {
        type: "sessions",
        data: {
          workspaceId: workspace.id,
          sessions: await listSessions(workspace.cwd, liveSessionsFor(workspace.id)),
        },
      });
    }

    function bindWorkspaceStatus(next: RuntimeHandle) {
      const key = keyForHandle(next);
      statusUnsubscribes.get(key)?.();
      const session = next.runtime.session;
      statusUnsubscribes.set(key, session.subscribe((event) => {
        if (["agent_start", "agent_end", "compaction_start", "compaction_end", "session_info_changed"].includes(event.type)) {
          void sendWorkspaceSessions(next.workspace).catch((error) => {
            console.warn("Failed to refresh workspace sessions:", error);
          });
        }
      }));
    }

    async function bindActive(next: RuntimeHandle) {
      const binding = await bindSession(
        ws,
        next,
        pendingUi,
        widgetHost,
        extensionUi,
        locks,
        ownerId,
        settingsStore,
        unsubscribe,
        () => handle === next && activeWorkspace.id === next.workspace.id,
      );
      unsubscribe = binding.unsubscribe;
      readOnly = binding.readOnly;
      send(ws, { type: "workspaces", data: { workspaces: publicWorkspaces(store), activeWorkspaceId: activeWorkspace.id } });
    }

    async function createHandle(workspace: Workspace, options?: { mode?: "new" | "continue" | "open"; sessionPath?: string }) {
      const next: RuntimeHandle = { workspace, runtime: await createRuntimeFor(workspace.cwd, options?.mode, options?.sessionPath) };
      registerHandle(next);
      // Apply settings-driven defaults to brand-new sessions only — resuming an
      // existing session preserves whatever it was last using.
      if (options?.mode !== "open" && options?.mode !== "continue") await applySessionDefaults(next.runtime.session);
      bindWorkspaceStatus(next);
      next.runtime.setRebindSession(async () => {
        registerHandle(next);
        bindWorkspaceStatus(next);
        if (handle !== next) return;
        await bindActive(next);
      });
      return next;
    }

    async function disposeHandle(workspaceId: string) {
      const existingHandles = handlesForWorkspace(workspaceId);
      for (const existing of existingHandles) {
        if (handle === existing) {
          unsubscribe?.();
          unsubscribe = undefined;
          handle = undefined;
        }
        await locks.release(existing.runtime.session.sessionFile, ownerId);
        await existing.runtime.dispose();
        const key = keyForHandle(existing);
        statusUnsubscribes.get(key)?.();
        statusUnsubscribes.delete(key);
        handles.delete(key);
      }
      activeHandleByWorkspace.delete(workspaceId);
    }

    async function openHandle(workspace: Workspace, sessionPath: string) {
      return handles.get(handleKey(workspace.id, sessionPath)) ?? await createHandle(workspace, { mode: "open", sessionPath });
    }

    async function activateHandle(workspace: Workspace, next: RuntimeHandle) {
      activeWorkspace = await store.touch(workspace.id);
      next.workspace = activeWorkspace;
      registerHandle(next);
      handle = next;
      await bindActive(next);
      return next;
    }

    async function activate(workspace: Workspace, options?: { mode?: "new" | "continue" | "open"; sessionPath?: string }) {
      activeWorkspace = await store.touch(workspace.id);
      const cached = options?.mode === "open" && options.sessionPath
        ? handles.get(handleKey(activeWorkspace.id, options.sessionPath))
        : activeHandleByWorkspace.get(activeWorkspace.id);
      const next = cached ?? await createHandle(activeWorkspace, options);
      return activateHandle(activeWorkspace, next);
    }

    try {
      await activate(activeWorkspace);
      send(ws, { type: "ready", data: { workspaces: publicWorkspaces(store), activeWorkspaceId: activeWorkspace.id, state: publicState(activeWorkspace, handle!.runtime.session), settings: settingsStore.get(), editors: availableEditors } });
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
            await disposeHandle(command.workspaceId);
            await store.remove(command.workspaceId);
            const next = store.list()[0] ?? (await store.add(initialCwd));
            await activate(next);
            send(ws, { type: "response", id, command: command.type, success: true });
            break;
          }
          case "list_sessions": {
            const workspace = workspaceFromCommand(store, activeWorkspace, command.workspaceId);
            const sessions = await listSessions(workspace.cwd, liveSessionsFor(workspace.id));
            send(ws, { type: "response", id, command: command.type, success: true, data: { sessions } });
            send(ws, { type: "sessions", data: { workspaceId: workspace.id, sessions } });
            break;
          }
          case "delete_session": {
            if (!command.sessionPath) throw new Error("Missing sessionPath");
            const workspace = workspaceFromCommand(store, activeWorkspace, command.workspaceId);
            // Refuse to delete the session file we currently hold open.
            if ([...handles.values()].some((existing) => existing.runtime.session.sessionFile === command.sessionPath)) {
              throw new Error("This session is open. Switch to another conversation first, then delete it.");
            }
            // Don't allow deletion of files outside the target workspace's session listing.
            const sessionsForWs = await listSessions(workspace.cwd);
            if (!sessionsForWs.some((s) => s.path === command.sessionPath)) {
              throw new Error("Session not found in this workspace.");
            }
            await fs.unlink(command.sessionPath);
            send(ws, { type: "response", id, command: command.type, success: true });
            await sendWorkspaceSessions(workspace);
            break;
          }
          case "switch_session":
            if (!command.sessionPath) throw new Error("Missing sessionPath");
            {
              const workspace = workspaceFromCommand(store, activeWorkspace, command.workspaceId);
              const lock = await locks.claim(command.sessionPath, workspace, ownerId);
              if (lock.owner === "other") throw lockConflictError(command.sessionPath, lock.lock);
              try {
                const next = await openHandle(workspace, command.sessionPath);
                await activateHandle(workspace, next);
                send(ws, { type: "response", id, command: command.type, success: true, data: { cancelled: false } });
              } catch (error) {
                await locks.release(command.sessionPath, ownerId);
                throw error;
              }
            }
            break;
          case "continue_recent":
            {
              const sessionPath = await mostRecentSessionPath(activeWorkspace.cwd);
              if (sessionPath) {
                const lock = await locks.claim(sessionPath, activeWorkspace, ownerId);
                if (lock.owner === "other") throw lockConflictError(sessionPath, lock.lock);
                try {
                  const next = await openHandle(activeWorkspace, sessionPath);
                  await activateHandle(activeWorkspace, next);
                  send(ws, { type: "response", id, command: command.type, success: true, data: { cancelled: false } });
                } catch (error) {
                  await locks.release(sessionPath, ownerId);
                  throw error;
                }
              } else {
                await activateHandle(activeWorkspace, await createHandle(activeWorkspace));
                send(ws, { type: "response", id, command: command.type, success: true, data: { cancelled: false } });
              }
            }
            break;
          case "new_session":
            await activateHandle(activeWorkspace, await createHandle(activeWorkspace));
            send(ws, { type: "response", id, command: command.type, success: true, data: { cancelled: false } });
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
              await activateHandle(activeWorkspace, await createHandle(activeWorkspace));
            } else if (name === "resume") {
              const sessionPath = await mostRecentSessionPath(activeWorkspace.cwd);
              if (sessionPath) {
                const lock = await locks.claim(sessionPath, activeWorkspace, ownerId);
                if (lock.owner === "other") throw lockConflictError(sessionPath, lock.lock);
                try {
                  await activateHandle(activeWorkspace, await openHandle(activeWorkspace, sessionPath));
                } catch (error) {
                  await locks.release(sessionPath, ownerId);
                  throw error;
                }
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
            const workspace = activeWorkspace;
            if (!command.message?.trim()) throw new Error("Missing message");
            send(ws, { type: "response", id, command: command.type, success: true });
            await session.prompt(command.message, { streamingBehavior: command.streamingBehavior });
            if (handle?.runtime.session === session && activeWorkspace.id === workspace.id) {
              send(ws, { type: "state", data: publicState(workspace, session) });
              send(ws, { type: "tree", data: { entries: publicTree(session) } });
            }
            await sendWorkspaceSessions(workspace);
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
            await sendWorkspaceSessions(activeWorkspace);
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
          case "list_files": {
            const files = await listWorkspaceFiles(activeWorkspace.cwd);
            send(ws, { type: "response", id, command: command.type, success: true, data: { files } });
            send(ws, { type: "files", data: { workspaceId: activeWorkspace.id, files } });
            break;
          }
          case "open_in_editor": {
            if (!command.editor || !command.path) throw new Error("Missing editor or path");
            // Path comes from the client as workspace-relative (the same shape
            // we ship in the `files` packet). Resolve against the active
            // workspace so the editor opens the right absolute location.
            const abs = path.resolve(activeWorkspace.cwd, command.path);
            // Don't allow escaping the workspace via "../" — keep this strictly
            // bounded so a misbehaving client can't `open -R /Users/.../id_rsa`.
            const rel = path.relative(activeWorkspace.cwd, abs);
            if (rel.startsWith("..") || path.isAbsolute(rel)) {
              throw new Error("Path is outside the active workspace");
            }
            await openInEditor(command.editor, abs);
            send(ws, { type: "response", id, command: command.type, success: true });
            break;
          }
          case "get_git": {
            const snapshot = await gitSnapshot(activeWorkspace.cwd);
            send(ws, { type: "response", id, command: command.type, success: true, data: snapshot });
            send(ws, { type: "git", data: snapshot });
            break;
          }
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
          case "extension_input": {
            // Terminal-encoded keystroke for the active overlay component
            // (e.g. autoresearch's fullscreen dashboard). Silently dropped
            // when there's no overlay; that's fine — extra keystrokes after
            // close are racy anyway.
            if (typeof command.data === "string" && command.data.length > 0) {
              widgetHost.dispatchInput(command.data);
            }
            send(ws, { type: "response", id, command: command.type, success: true });
            break;
          }
          case "trigger_shortcut": {
            if (!command.key || !handle) throw new Error("Missing key or no active session");
            const target = canonicalKeyId(command.key);
            const shortcuts = handle.runtime.session.extensionRunner.getShortcuts({});
            const matchedHandler = (() => {
              for (const [registeredKey, sc] of shortcuts) {
                if (canonicalKeyId(registeredKey) === target) return sc.handler;
              }
              return undefined;
            })();
            if (!matchedHandler) {
              send(ws, { type: "response", id, command: command.type, success: false, error: `No shortcut registered for ${command.key}` });
              break;
            }
            // Fire and forget — extension handlers are usually short, but we
            // don't want to block the WS message loop on a slow one. The cast
            // sidesteps the strict ExtensionContext shape; our buildExtension-
            // Context returns a structurally-compatible subset.
            void Promise.resolve(matchedHandler(buildExtensionContext(handle, extensionUi) as Parameters<typeof matchedHandler>[0]))
              .catch((error) => send(ws, { type: "notification", data: { message: `Shortcut handler failed: ${error instanceof Error ? error.message : String(error)}`, level: "error" } }));
            send(ws, { type: "response", id, command: command.type, success: true });
            break;
          }
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
      widgetHost.reset();
      for (const resolve of pendingUi.values()) resolve(undefined);
      pendingUi.clear();
      await Promise.all([...handles.values()].map(async (existing) => {
        await locks.release(existing.runtime.session.sessionFile, ownerId);
        await existing.runtime.dispose();
      }));
      for (const releaseStatus of statusUnsubscribes.values()) releaseStatus();
      statusUnsubscribes.clear();
      handles.clear();
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
