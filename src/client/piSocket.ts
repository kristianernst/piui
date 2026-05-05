export type Workspace = {
  id: string;
  cwd: string;
  name: string;
  lastOpenedAt: string;
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

export type PiResourceSummary = {
  commands: Array<{ name: string; description?: string; source: string }>;
  tools: Array<{ name: string; description?: string; source?: unknown }>;
  activeTools: string[];
  prompts: Array<{ name: string; description?: string }>;
  skills: Array<{ name: string; description?: string }>;
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

export type PiTreeEntry = {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  forkable: boolean;
  label?: string;
  text?: string;
};

export type ExtensionUiRequest =
  | { id: string; kind: "select"; title: string; options: string[]; opts?: unknown }
  | { id: string; kind: "confirm"; title: string; message: string; opts?: unknown }
  | { id: string; kind: "input"; title: string; placeholder?: string; opts?: unknown }
  | { id: string; kind: string; [key: string]: unknown };

export type PiPacket =
  | { type: "ready"; data: { workspaces: Workspace[]; activeWorkspaceId: string; state: PiState } }
  | { type: "workspaces"; data: { workspaces: Workspace[]; activeWorkspaceId: string } }
  | { type: "workspace"; data: Workspace }
  | { type: "sessions"; data: { workspaceId: string; sessions: PiSessionInfo[] } }
  | { type: "state"; data: PiState }
  | { type: "messages"; data: { messages: AgentMessage[] } }
  | { type: "resources"; data: PiResourceSummary }
  | { type: "models"; data: { models: PiModelSummary[] } }
  | { type: "tree"; data: { entries: PiTreeEntry[] } }
  | { type: "extension_ui_request"; request: ExtensionUiRequest }
  | { type: "extension_ui_status"; data: { key: string; text?: string; value?: unknown } }
  | { type: "notification"; data: { message: string; level?: "info" | "warning" | "error" } }
  | { type: "event"; event: AgentEvent }
  | { type: "response"; id?: string; command: string; success: boolean; data?: unknown; error?: string };

export type AgentMessage =
  | { role: "user"; content: string | ContentBlock[]; timestamp?: number }
  | { role: "assistant"; content: ContentBlock[]; stopReason?: string; errorMessage?: string; timestamp?: number }
  | { role: "toolResult"; toolCallId: string; toolName: string; content: ContentBlock[]; isError: boolean; timestamp?: number }
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
  result?: { content?: ContentBlock[]; details?: unknown };
  isError?: boolean;
  steering?: string[];
  followUp?: string[];
};

export function connectPi(onPacket: (packet: PiPacket) => void, onStatus: (status: "connecting" | "open" | "closed") => void) {
  let ws: WebSocket | null = null;
  const pending: Record<string, unknown>[] = [];
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
    send(command: Record<string, unknown>) {
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
