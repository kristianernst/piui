export type PiState = {
  cwd: string;
  sessionFile?: string;
  sessionId: string;
  isStreaming: boolean;
  model?: { provider: string; id: string; name?: string; contextWindow?: number } | null;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  messageCount: number;
  usage?: { tokens?: number; contextWindow?: number; percent?: number | null; cost?: number } | null;
};

export type PiPacket =
  | { type: "ready"; data: PiState }
  | { type: "state"; data: PiState }
  | { type: "messages"; data: { messages: AgentMessage[] } }
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
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
  onStatus("connecting");

  ws.addEventListener("open", () => onStatus("open"));
  ws.addEventListener("close", () => onStatus("closed"));
  ws.addEventListener("message", (event) => onPacket(JSON.parse(event.data) as PiPacket));

  return {
    send(command: Record<string, unknown>) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(command));
    },
    close() {
      ws.close();
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
