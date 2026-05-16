export type Workspace = {
  id: string;
  cwd: string;
  name: string;
  lastOpenedAt: string;
  /** True for the launch directory — server refuses to remove it, UI hides the
   *  delete affordance. Computed server-side; never persisted. */
  pinned?: boolean;
};

export type PiSessionInfo = {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  liveSessionId?: string;
  isRunning?: boolean;
};

export type PiState = {
  workspace: Workspace;
  cwd: string;
  sessionFile?: string;
  sessionId: string;
  isStreaming: boolean;
  model?: { provider: string; id: string; name?: string; contextWindow?: number } | null;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  isCompacting: boolean;
  isRetrying: boolean;
  pending: { steering: readonly string[]; followUp: readonly string[] };
  activeTools: string[];
  messageCount: number;
  usage?: { tokens?: number; contextWindow?: number; percent?: number | null; cost?: number } | null;
};

export type PiSourceInfo = {
  path: string;
  source: string;
  scope?: "user" | "project" | "temporary";
  origin?: "package" | "top-level";
  baseDir?: string;
};

export type PiResourceSummary = {
  commands: Array<{ name: string; description?: string; source: string; sourceInfo?: PiSourceInfo }>;
  tools: Array<{ name: string; description?: string; sourceInfo?: PiSourceInfo }>;
  activeTools: string[];
  prompts: Array<{ name: string; description?: string }>;
  skills: Array<{ name: string; description?: string; sourceInfo?: PiSourceInfo }>;
  extensions: Array<{
    name: string;
    path: string;
    resolvedPath?: string;
    sourceInfo?: PiSourceInfo;
    commandCount: number;
    toolCount: number;
    shortcutCount: number;
    flagCount: number;
    handlerCount: number;
  }>;
  extensionErrors: Array<{ path: string; error: string }>;
  agentsFiles: Array<{ path: string }>;
  diagnostics: Array<{ type?: string; message?: string }>;
};

export type PiModelSummary = {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  available: boolean;
  current: boolean;
};

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type PiModelRef = { provider: string; modelId: string };

export type PiAppearanceSettings = {
  colorScheme: "system" | "light" | "dark";
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  rightSidebarWidth: number;
};

export type PromptAttachment =
  | {
      id: string;
      kind: "image";
      name: string;
      mimeType: string;
      data: string;
      size: number;
      width?: number;
      height?: number;
      originalWidth?: number;
      originalHeight?: number;
    }
  | {
      id: string;
      kind: "text";
      name: string;
      mimeType?: string;
      text: string;
      size: number;
      truncated?: boolean;
    };

export type PiSettings = {
  defaultModel: PiModelRef | null;
  defaultThinkingLevel: PiThinkingLevel | null;
  titleModel: PiModelRef | null;
  showStarterPrompts: boolean;
  appearance: PiAppearanceSettings;
};

export type PiNavigationState = {
  activeWorkspaceId?: string;
  activeSessionPathByWorkspace: Record<string, string>;
  openWorkspaceIds: string[];
  expandedSessionWorkspaceIds: string[];
  openFileTreePathsByWorkspace: Record<string, string[]>;
  rightSidebarTab: "diffs" | "files";
  updatedAt?: string;
};

export type PiNavigationPatch = Partial<Pick<
  PiNavigationState,
  "openWorkspaceIds" | "expandedSessionWorkspaceIds" | "openFileTreePathsByWorkspace" | "rightSidebarTab"
>>;

export type GitFileStatus = {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "copied" | "typechange" | "unknown";
  index: string;
  worktree: string;
};

export type GitSnapshot = {
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

export type PiTreeEntry = {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  forkable: boolean;
  label?: string;
  text?: string;
};

export type SessionRoute = {
  runtimeId: string;
  workspaceId: string;
  sessionPath?: string;
  sessionId: string;
};

export type SessionScoped<T extends object> = T & SessionRoute;

export function hasSessionRoute(value: unknown): value is SessionRoute {
  if (!value || typeof value !== "object") return false;
  const route = value as Partial<SessionRoute>;
  return (
    typeof route.runtimeId === "string" &&
    typeof route.workspaceId === "string" &&
    typeof route.sessionId === "string" &&
    (route.sessionPath === undefined || typeof route.sessionPath === "string")
  );
}

export function sessionRouteKey(route: Pick<SessionRoute, "runtimeId" | "workspaceId" | "sessionPath">): string {
  return route.sessionPath ? `${route.workspaceId}\0${route.sessionPath}` : `runtime:${route.runtimeId}`;
}

export type ExtensionUiRequest =
  | { id: string; kind: "select"; title: string; options: string[]; opts?: unknown }
  | { id: string; kind: "confirm"; title: string; message: string; opts?: unknown }
  | { id: string; kind: "input"; title: string; placeholder?: string; opts?: unknown }
  | { id: string; kind: string; title?: string; message?: string; options?: string[]; placeholder?: string; [key: string]: unknown };

export type SessionStateSnapshot = SessionScoped<{ state: PiState; revision: number }>;
export type SessionMessagesSnapshot = SessionScoped<{ messages: AgentMessage[]; revision: number }>;
export type SessionResourcesSnapshot = SessionScoped<{ resources: PiResourceSummary }>;
export type SessionModelsSnapshot = SessionScoped<{ models: PiModelSummary[] }>;
export type SessionTreeSnapshot = SessionScoped<{ entries: PiTreeEntry[] }>;
export type SessionEventPacket = SessionScoped<{ event: AgentEvent; seq: number }>;
export type SessionExtensionRequest = SessionScoped<{ request: ExtensionUiRequest }>;
export type SessionExtensionStatus = SessionScoped<{ key: string; text?: string; value?: unknown }>;
export type SessionExtensionWidget = SessionScoped<{ slot: string; lines?: string[]; removed?: true }>;
export type SessionShortcuts = SessionScoped<{ shortcuts: Array<{ key: string; description?: string }> }>;

export type PiPacket =
  | { type: "ready"; data: { workspaces: Workspace[]; activeWorkspaceId: string | null; state: SessionStateSnapshot | null; settings?: PiSettings; editors?: Array<{ id: string; label: string; hasIcon: boolean }>; navigation?: PiNavigationState } }
  | { type: "workspaces"; data: { workspaces: Workspace[]; activeWorkspaceId: string | null } }
  | { type: "workspace"; data: Workspace }
  | { type: "navigation"; data: PiNavigationState }
  | { type: "sessions"; data: { workspaceId: string; sessions: PiSessionInfo[] } }
  | { type: "state"; data: SessionStateSnapshot }
  | { type: "messages"; data: SessionMessagesSnapshot }
  | { type: "resources"; data: SessionResourcesSnapshot }
  | { type: "models"; data: SessionModelsSnapshot }
  | { type: "settings"; data: PiSettings }
  | { type: "git"; data: { workspaceId: string; snapshot: GitSnapshot } }
  | { type: "files"; data: { workspaceId: string; files: string[] } }
  | { type: "tree"; data: SessionTreeSnapshot }
  | { type: "extension_ui_request"; data: SessionExtensionRequest }
  | { type: "extension_ui_status"; data: SessionExtensionStatus }
  | { type: "extension_ui_widget"; data: SessionExtensionWidget }
  | { type: "extension_reset"; data: SessionRoute }
  | { type: "shortcuts"; data: SessionShortcuts }
  | { type: "notification"; data: { message: string; level?: "info" | "warning" | "error" } }
  | { type: "event"; data: SessionEventPacket }
  | { type: "response"; id?: string; command: string; success: boolean; data?: unknown; error?: string };

type RoutedCommand<T extends object> = T & SessionRoute;

export type PiWorkspaceCommand =
  | { id?: string; type: "list_workspaces" }
  | { id?: string; type: "open_workspace"; cwd?: string; name?: string }
  | { id?: string; type: "switch_workspace"; workspaceId: string }
  | { id?: string; type: "remove_workspace"; workspaceId: string }
  | { id?: string; type: "list_sessions"; workspaceId: string }
  | { id?: string; type: "switch_session"; workspaceId: string; sessionPath: string }
  | { id?: string; type: "delete_session"; workspaceId: string; sessionPath: string }
  | { id?: string; type: "continue_recent"; workspaceId: string }
  | { id?: string; type: "new_session"; workspaceId: string }
  | { id?: string; type: "list_files"; workspaceId: string }
  | { id?: string; type: "get_git"; workspaceId: string }
  | { id?: string; type: "set_settings"; settings: Partial<PiSettings> }
  | { id?: string; type: "set_navigation"; navigation: PiNavigationPatch }
  | { id?: string; type: "open_in_editor"; workspaceId: string; editor: string; path: string };

export type PiSessionCommand =
  | RoutedCommand<{ id?: string; type: "get_state" | "get_messages" | "get_resources" | "get_models" | "get_tree" }>
  | RoutedCommand<{ id?: string; type: "reload_resources" | "abort" | "clone" | "export_html" }>
  | RoutedCommand<{ id?: string; type: "compact"; customInstructions?: string }>
  | RoutedCommand<{ id?: string; type: "fork"; entryId: string }>
  | RoutedCommand<{ id?: string; type: "prompt"; message: string; streamingBehavior?: "steer" | "followUp"; clientMessageId?: string; attachments?: PromptAttachment[] }>
  | RoutedCommand<{ id?: string; type: "steer" | "follow_up"; message: string; attachments?: PromptAttachment[] }>
  | RoutedCommand<{ id?: string; type: "invoke_command"; commandName: string }>
  | RoutedCommand<{ id?: string; type: "set_session_name"; name: string }>
  | RoutedCommand<{ id?: string; type: "cycle_model" }>
  | RoutedCommand<{ id?: string; type: "set_model"; provider: string; modelId: string }>
  | RoutedCommand<{ id?: string; type: "set_thinking_level"; level: PiThinkingLevel }>
  | RoutedCommand<{ id?: string; type: "extension_ui_response"; uiRequestId: string; value: unknown }>
  | RoutedCommand<{ id?: string; type: "trigger_shortcut"; key: string }>
  | RoutedCommand<{ id?: string; type: "extension_input"; data: string }>;

export type PiSessionCommandBody = PiSessionCommand extends infer Command
  ? Command extends SessionRoute
    ? Omit<Command, keyof SessionRoute>
    : never
  : never;

export type PiClientCommand = PiWorkspaceCommand | PiSessionCommand;

export type ToolResultDetails =
  | {
      kind: "sql_result";
      title?: string;
      sql?: string;
      columns: Array<{ name: string; dataType?: string }>;
      rows: Array<Record<string, unknown>>;
      rowCount: number;
      truncated?: boolean;
      elapsedMs?: number;
    }
  | {
      kind: "analytics_visualization";
      title?: string;
      sql?: string;
      // Single-series chart shapes the UI knows how to render. The toggle in
      // VisualizationResult lets the user swap between them at view time.
      // - line: smooth filled line (was the original "line")
      // - area: same shape but a heavier fill, good for cumulative-look
      // - step: stepAfter line, good for state changes
      // - bar: vertical bars (was the original "bar")
      // - horizontalBar: flipped axes — long category names along Y
      // - scatter: independent points, good for pair correlations
      // - waterfall: bars with running-total positioning + signed colors,
      //   approximating a finance-style waterfall from a single delta column
      // - cumulative: line of the running sum of `y` along `x` order
      // - pie: arcs over `y` summed per `x` category — best at small N
      chartType: "bar" | "line" | "area" | "step" | "horizontalBar" | "scatter" | "waterfall" | "cumulative" | "pie";
      x: string;
      y: string;
      xLabel?: string;
      yLabel?: string;
      columns: Array<{ name: string; dataType?: string }>;
      rows: Array<Record<string, unknown>>;
      rowCount: number;
      truncated?: boolean;
      elapsedMs?: number;
    }
  | {
      kind: "database_schema";
      title?: string;
      schemas: string[];
      tables: Array<{ schema: string; name: string; type: string; rowEstimate?: number | null }>;
      columns: Array<{ schema: string; table: string; name: string; dataType: string; nullable: boolean }>;
    }
  | {
      // Edit-tool result. Pi doesn't tag these with a `kind`, so the client
      // synthesizes one by checking for the `diff` field (a unified diff
      // string). We surface a syntax-highlighted, length-capped preview.
      kind: "edit_diff";
      diff: string;
      firstChangedLine?: number;
    };

export type AgentMessage =
  | { role: "user"; content: string | ContentBlock[]; timestamp?: number }
  | { role: "assistant"; content: ContentBlock[]; stopReason?: string; errorMessage?: string; timestamp?: number }
  | { role: "toolResult"; toolCallId: string; toolName: string; content: ContentBlock[]; details?: ToolResultDetails; isError: boolean; timestamp?: number }
  | { role: "bashExecution"; command: string; output: string; exitCode?: number; cancelled?: boolean; timestamp?: number }
  | { role: string; [key: string]: unknown };

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "image"; data: string; mimeType: string };

export type AgentEvent = {
  type: string;
  message?: AgentMessage;
  messages?: AgentMessage[];
  assistantMessageEvent?: { type: string; delta?: string; content?: string; toolCall?: { id: string; name: string; arguments: Record<string, unknown> } };
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  partialResult?: { content?: ContentBlock[] };
  result?: { content?: ContentBlock[]; details?: ToolResultDetails };
  isError?: boolean;
  steering?: string[];
  followUp?: string[];
};

export function connectPi(onPacket: (packet: PiPacket) => void, onStatus: (status: "connecting" | "open" | "closed") => void) {
  let ws: WebSocket | null = null;
  const pending: PiClientCommand[] = [];
  onStatus("connecting");

  void fetch("/api/health")
    .then((response) => response.json() as Promise<{ wsToken: string }>)
    .then(({ wsToken }) => {
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${protocol}://${window.location.host}/ws?token=${encodeURIComponent(wsToken)}`);
      ws.addEventListener("open", () => {
        onStatus("open");
        while (pending.length) ws?.send(JSON.stringify(pending.shift()));
      });
      ws.addEventListener("close", () => onStatus("closed"));
      ws.addEventListener("message", (event) => onPacket(JSON.parse(event.data) as PiPacket));
    })
    .catch(() => onStatus("closed"));

  return {
    send(command: PiClientCommand) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(command));
      else pending.push(command);
    },
    close() {
      ws?.close();
    },
  };
}

export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const b = block as ContentBlock;
      if (b.type === "text") return b.text;
      if (b.type === "thinking") return b.thinking;
      if (b.type === "toolCall") return `${b.name}(${JSON.stringify(b.arguments)})`;
      if (b.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
