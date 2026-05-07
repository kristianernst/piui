import React, { Component, lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { Toaster, toast } from "sonner";
import { measureLineStats, prepareWithSegments, type PreparedTextWithSegments } from "@chenglou/pretext";
import hljs from "highlight.js/lib/common";
import {
  IconArrowUpSlim,
  IconChev,
  IconChart,
  IconClose,
  IconCode,
  IconDb,
  IconDiff,
  IconExpand,
  IconFile,
  IconFolder,
  IconMoon,
  IconPlusSlim,
  IconSearch,
  IconSettings,
  IconSidebarLeft,
  IconSidebarRight,
  IconStop,
  IconSun,
  IconTerminal,
} from "./icons";
import {
  connectPi,
  contentToText,
  type AgentEvent,
  type AgentMessage,
  type ExtensionUiRequest,
  type PiModelSummary,
  type PiResourceSummary,
  type PiSessionInfo,
  type PiSettings,
  type PiState,
  type PiThinkingLevel,
  type ToolResultDetails,
  type Workspace,
} from "./piSocket";
import "./styles.css";
import "./stage3.css";

const VisualizationChart = lazy(() => import("./VisualizationChart"));

type UiTool = {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  output?: string;
  details?: ToolResultDetails;
  status: "running" | "done" | "error";
};

// One ordered, append-only stream of "what happened" inside an assistant turn.
// We keep the chronological order so the reasoning timeline mirrors what the
// agent actually did: thought → tool → thought → tool → … → final text.
type UiBlock =
  | { kind: "thought"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: UiTool };

type UiMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;          // user role only
  blocks?: UiBlock[];    // assistant role only — chronological
  streaming?: boolean;
  startedAt?: number;    // assistant only — for duration metadata
  endedAt?: number;
};

type AppErrorBoundaryState = { error?: Error };

class AppErrorBoundary extends Component<{ children: React.ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Piui render error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="fatalView">
        <div className="fatalPanel">
          <div className="fatalEyebrow">Render error</div>
          <h1>Piui hit a UI exception.</h1>
          <p>{this.state.error.message}</p>
          <button onClick={() => this.setState({ error: undefined })}>Try again</button>
        </div>
      </div>
    );
  }
}

function uiMessageFromAgent(message: AgentMessage, id: string): UiMessage | null {
  if (message.role === "user") return { id, role: "user", text: contentToText(message.content) };
  if (message.role === "assistant") {
    const content = Array.isArray(message.content) ? message.content : [];
    const blocks: UiBlock[] = [];
    for (const block of content) {
      if (block.type === "thinking" && block.thinking.trim()) blocks.push({ kind: "thought", text: block.thinking });
      else if (block.type === "text" && block.text.trim()) blocks.push({ kind: "text", text: block.text });
      else if (block.type === "toolCall") blocks.push({ kind: "tool", tool: { id: block.id, name: block.name, args: block.arguments, status: "done" } });
    }
    return { id, role: "assistant", text: "", blocks };
  }
  // Tool outputs and bash output are attached to the corresponding tool via
  // `tool_execution_end` events — don't render them as separate system messages.
  return null;
}

function asMessages(messages: AgentMessage[], prefix = "m"): UiMessage[] {
  const next: UiMessage[] = [];
  messages.forEach((message, index) => {
    const uiMessage = uiMessageFromAgent(message, `${prefix}-${index}`);
    if (uiMessage) next.push(uiMessage);
  });
  return coalesceAssistantTurns(next);
}

// Pi splits a single agent turn into multiple `assistant` messages (one per
// think+tool step). For the UI we want one logical turn = one timeline, so we
// merge consecutive assistants into a single message preserving block order.
function coalesceAssistantTurns(messages: UiMessage[]): UiMessage[] {
  const out: UiMessage[] = [];
  for (const message of messages) {
    const last = out[out.length - 1];
    if (message.role === "assistant" && last?.role === "assistant") {
      last.blocks = [...(last.blocks ?? []), ...(message.blocks ?? [])];
      last.endedAt = message.endedAt ?? last.endedAt;
      continue;
    }
    out.push({ ...message });
  }
  return out;
}

// Hydrate tool outputs onto previously-saved messages by matching tool ids
// against any toolResult sibling messages received in the same payload.
function hydrateToolOutputs(history: AgentMessage[], ui: UiMessage[]): UiMessage[] {
  const outputs = new Map<string, { text: string; details?: ToolResultDetails; isError: boolean }>();
  for (const message of history) {
    if (message.role === "toolResult") {
      const id = String((message as { toolCallId?: unknown }).toolCallId ?? "");
      if (!id) continue;
      const details = isToolResultDetails((message as { details?: unknown }).details)
        ? (message as { details: ToolResultDetails }).details
        : undefined;
      outputs.set(id, { text: contentToText(message.content), details, isError: !!message.isError });
    }
  }
  if (outputs.size === 0) return ui;
  return ui.map((message): UiMessage => {
    if (message.role !== "assistant" || !message.blocks) return message;
    const blocks: UiBlock[] = message.blocks.map((block) => {
      if (block.kind !== "tool") return block;
      const result = outputs.get(block.tool.id);
      if (!result) return block;
      const status: UiTool["status"] = result.isError ? "error" : "done";
      return { kind: "tool", tool: { ...block.tool, output: result.text, details: result.details, status } };
    });
    return { ...message, blocks };
  });
}

function isToolResultDetails(value: unknown): value is ToolResultDetails {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "sql_result" || kind === "analytics_visualization" || kind === "database_schema";
}

function App() {
  const [connection, setConnection] = useState<"connecting" | "open" | "closed">("connecting");
  const [state, setState] = useState<PiState | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<PiSessionInfo[]>([]);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [models, setModels] = useState<PiModelSummary[]>([]);
  const [settings, setSettings] = useState<PiSettings | null>(null);
  const [resources, setResources] = useState<PiResourceSummary | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [dark, setDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  const [draft, setDraft] = useState("");
  const [uiRequest, setUiRequest] = useState<ExtensionUiRequest | null>(null);
  const socketRef = useRef<ReturnType<typeof connectPi> | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  // Autoscroll is "sticky" — we follow new content to the bottom unless the
  // user has manually scrolled away. Once they scroll back near the bottom we
  // re-engage. The threshold buffers small layout jitter (image loads, font
  // metrics settling, code-block reflows) from being mistaken for a scroll-up.
  const stickToBottomRef = useRef(true);
  const SCROLL_STICK_THRESHOLD_PX = 80;

  useEffect(() => {
    document.body.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    const socket = connectPi((packet) => {
      if (packet.type === "ready") {
        setState(packet.data.state);
        setWorkspaces(packet.data.workspaces);
        setActiveWorkspaceId(packet.data.activeWorkspaceId);
        if (packet.data.settings) setSettings(packet.data.settings);
      }
      if (packet.type === "workspaces") {
        setWorkspaces(packet.data.workspaces);
        setActiveWorkspaceId(packet.data.activeWorkspaceId);
      }
      if (packet.type === "state") setState(packet.data);
      if (packet.type === "sessions") setSessions(packet.data.sessions);
      if (packet.type === "models") setModels(packet.data.models);
      if (packet.type === "settings") setSettings(packet.data);
      if (packet.type === "resources") setResources(packet.data);
      if (packet.type === "files") setFiles(packet.data.files);
      if (packet.type === "messages") setMessages(hydrateToolOutputs(packet.data.messages, asMessages(packet.data.messages)));
      if (packet.type === "extension_ui_request") setUiRequest(packet.request);
      if (packet.type === "notification") pushNotice(packet.data.message, packet.data.level);
      if (packet.type === "event") applyEvent(packet.event);
      if (packet.type === "response" && !packet.success) {
        pushNotice(packet.error ?? "Unknown Pi error", "error");
      }
    }, setConnection);
    socketRef.current = socket;
    return () => socket.close();
  }, []);

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages]);

  // Refresh `@`-mention candidates whenever the active workspace changes.
  // We send a fresh request rather than caching per-workspace because file
  // listings drift quickly during active development.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    setFiles([]);
    socketRef.current?.send({ type: "list_files" });
  }, [activeWorkspaceId]);

  function handleThreadScroll() {
    const el = threadRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= SCROLL_STICK_THRESHOLD_PX;
  }

  function pushNotice(message: string, level?: "info" | "warning" | "error") {
    if (level === "error") toast.error(message);
    else if (level === "warning") toast.warning(message);
    else toast(message);
  }

  function applyEvent(event: AgentEvent) {
    if (event.type === "message_start" && event.message && event.message.role === "user") {
      setMessages((prev) => {
        const ui = uiMessageFromAgent(event.message!, `e-${Date.now()}`);
        if (!ui) return prev;
        // Dedup against any optimistic copy we already pushed locally.
        if (prev.some((m) => m.role === "user" && m.text === ui.text)) return prev;
        // `agent_start` may arrive before the server-side user message_start,
        // leaving a streaming assistant at the tail. Splice the user message in
        // before it so the chronological order matches reality.
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          return [...prev.slice(0, -1), ui, last];
        }
        return [...prev, ui];
      });
      return;
    }
    if (event.type === "agent_start") {
      const now = Date.now();
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        // If the previous turn is still an assistant (e.g. on reconnect) we
        // continue extending it instead of starting a new visual block.
        if (last?.role === "assistant") {
          return prev.map((message, index) =>
            index === prev.length - 1
              ? { ...message, streaming: true, startedAt: message.startedAt ?? now, endedAt: undefined }
              : message,
          );
        }
        return [...prev, { id: `a-${now}`, role: "assistant", text: "", blocks: [], streaming: true, startedAt: now }];
      });
      // Dismiss any lingering error toasts when a new turn starts.
      toast.dismiss();
      return;
    }
    if (event.type === "message_update" && event.assistantMessageEvent) {
      const delta = event.assistantMessageEvent;
      const kind = delta.type === "thinking_delta" ? "thought" : delta.type === "text_delta" ? "text" : null;
      const piece = delta.delta ?? "";
      if (!kind || !piece) return;
      setMessages((prev) => updateLastAssistant(prev, (message) => appendChunk(message, kind, piece)));
      return;
    }
    if (event.type === "tool_execution_start" && event.toolCallId && event.toolName) {
      const tool: UiTool = { id: event.toolCallId, name: event.toolName, args: event.args, status: "running" };
      setMessages((prev) => updateLastAssistant(prev, (message) => ({
        ...message,
        blocks: [...(message.blocks ?? []), { kind: "tool", tool }],
      })));
      return;
    }
    if ((event.type === "tool_execution_update" || event.type === "tool_execution_end") && event.toolCallId) {
      const output = contentToText(event.result?.content ?? event.partialResult?.content ?? "");
      const details = event.result?.details;
      const status = event.type === "tool_execution_end" ? (event.isError ? "error" : "done") : "running";
      setMessages((prev) => updateLastAssistant(prev, (message) => ({
        ...message,
        blocks: (message.blocks ?? []).map((block) =>
          block.kind === "tool" && block.tool.id === event.toolCallId
            ? { ...block, tool: { ...block.tool, output, details: details ?? block.tool.details, status } }
            : block,
        ),
      })));
      return;
    }
    if (event.type === "agent_end" || (event.type === "message_end" && event.message?.role === "assistant")) {
      setMessages((prev) => updateLastAssistant(prev, (message) => ({
        ...message,
        streaming: event.type === "message_end" ? message.streaming : false,
        endedAt: event.type === "agent_end" ? Date.now() : message.endedAt,
      })));
    }
  }

  function appendChunk(message: UiMessage, kind: "thought" | "text", piece: string): UiMessage {
    const blocks = [...(message.blocks ?? [])];
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind) {
      blocks[blocks.length - 1] = { kind, text: last.text + piece };
    } else {
      blocks.push({ kind, text: piece });
    }
    return { ...message, blocks };
  }

  function sendPrompt(text: string, streamingBehavior?: "steer" | "followUp") {
    // The user is engaging with the conversation again — re-engage autoscroll
    // even if they had scrolled up to read earlier content.
    stickToBottomRef.current = true;
    // Optimistically render the user's turn so it never appears below the
    // streaming assistant if `agent_start` lands first on the wire.
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", text }]);
    socketRef.current?.send({ type: "prompt", message: text, streamingBehavior });
  }

  function queuePrompt(text: string, mode: "steer" | "follow_up") {
    socketRef.current?.send({ type: mode, message: text });
  }

  function abort() {
    socketRef.current?.send({ type: "abort" });
  }

  function newSession() {
    setMessages([]);
    socketRef.current?.send({ type: "new_session" });
  }

  function openWorkspace() {
    // Ask the server to pop a native folder picker; cwd is filled in there.
    setMessages([]);
    socketRef.current?.send({ type: "open_workspace" });
  }

  function switchWorkspace(workspaceId: string) {
    setMessages([]);
    setSessions([]);
    socketRef.current?.send({ type: "switch_workspace", workspaceId });
  }

  function removeWorkspace(workspaceId: string) {
    socketRef.current?.send({ type: "remove_workspace", workspaceId });
  }

  function switchSession(sessionPath: string) {
    setMessages([]);
    socketRef.current?.send({ type: "switch_session", sessionPath });
  }

  function deleteSession(sessionPath: string) {
    socketRef.current?.send({ type: "delete_session", sessionPath });
  }

  function updateSettings(patch: Partial<PiSettings>) {
    // Optimistic update so the dialog feels snappy; the server will broadcast
    // a settings packet that supersedes this.
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
    socketRef.current?.send({ type: "set_settings", settings: patch });
  }


  const sessionTitle = state?.workspace.name ? state.workspace.name : "Pi";
  const headerTitle = messages[0]?.text.slice(0, 64) || sessionTitle;

  return (
    <div className="shell">
      <LeftSidebar
        open={leftOpen}
        onToggle={() => setLeftOpen((v) => !v)}
        onNewSession={newSession}
        onOpenWorkspace={openWorkspace}
        onSwitchWorkspace={switchWorkspace}
        onRemoveWorkspace={removeWorkspace}
        onSwitchSession={switchSession}
        onDeleteSession={deleteSession}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        sessions={sessions}
        activeSessionId={state?.sessionId}
        dark={dark}
        onToggleDark={() => setDark((v) => !v)}
        models={models}
        currentModel={state?.model ?? null}
        settings={settings}
        onUpdateSettings={updateSettings}
      />
      <main className="app">
        <header className="topbar">
          <div className="topbar-side">
            {!leftOpen && (
              <button className="ghost" onClick={() => setLeftOpen(true)} title="Show sidebar">
                <IconSidebarLeft />
              </button>
            )}
          </div>
          <div className="titleBlock">{headerTitle}</div>
          <div className="topbar-side right">
            {!rightOpen && (
              <button className="ghost" onClick={() => setRightOpen(true)} title="Show diffs">
                <IconSidebarRight />
              </button>
            )}
          </div>
        </header>

        <div className="thread" ref={threadRef} onScroll={handleThreadScroll}>
          {messages.length === 0 ? <EmptyState /> : messages.map((message) => <MessageView key={message.id} message={message} />)}
        </div>

        <Composer
          state={state}
          connection={connection}
          value={draft}
          onValueChange={setDraft}
          onSend={sendPrompt}
          onSteer={(text) => queuePrompt(text, "steer")}
          onFollowUp={(text) => queuePrompt(text, "follow_up")}
          onAbort={abort}
          onThinking={(level) => socketRef.current?.send({ type: "set_thinking_level", level })}
          models={models}
          onSetModel={(provider, modelId) => socketRef.current?.send({ type: "set_model", provider, modelId })}
          resources={resources}
          files={files}
        />
      </main>
      <RightSidebar open={rightOpen} onToggle={() => setRightOpen((v) => !v)} />
      {uiRequest && (
        <ExtensionDialog
          request={uiRequest}
          onResolve={(value) => {
            socketRef.current?.send({ type: "extension_ui_response", uiRequestId: uiRequest.id, value });
            setUiRequest(null);
          }}
        />
      )}
      <Toaster
        theme={dark ? "dark" : "light"}
        position="bottom-right"
        richColors
        closeButton
        toastOptions={{ duration: 5000 }}
      />
    </div>
  );
}

function updateLastAssistant(messages: UiMessage[], updater: (message: UiMessage) => UiMessage): UiMessage[] {
  const next = [...messages];
  let index = next.length - 1;
  while (index >= 0 && next[index].role !== "assistant") index--;
  if (index === -1) next.push(updater({ id: `a-${Date.now()}`, role: "assistant", text: "", blocks: [], streaming: true }));
  else next[index] = updater({ ...next[index] });
  return next;
}

// Pi logo from https://pi.dev/logo.svg, inlined and re-fitted to use
// `currentColor` so it picks up the heading's color (black in light mode,
// near-white in dark mode) without a second asset round-trip.
function PiLogo({ className, title = "Pi" }: { className?: string; title?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 800 800"
      className={className}
      role="img"
      aria-label={title}
      fill="currentColor"
    >
      <title>{title}</title>
      <path
        fillRule="evenodd"
        d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"
      />
      <path d="M517.36 400 H634.72 V634.72 H517.36 Z" />
    </svg>
  );
}

function EmptyState() {
  return (
    <section className="empty fadeUp">
      <h1><PiLogo className="empty-piLogo" />, in the browser.</h1>
      <p>This local web app talks to Pi through its Node SDK, so it uses your real Pi config, credentials, sessions, tools, context files, extensions, and working directory.</p>
    </section>
  );
}

function MessageView({ message }: { message: UiMessage }) {
  if (message.role === "user") return <div className="msg user fadeUp"><div className="bubble">{message.text}</div></div>;

  const blocks = message.blocks ?? [];
  // The final answer is the last `text` block; everything before it (thoughts,
  // tools, earlier intermediate text) belongs to the reasoning timeline.
  let answerIndex = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === "text") { answerIndex = i; break; }
  }
  const timeline = answerIndex === -1 ? blocks : blocks.slice(0, answerIndex);
  const answer = answerIndex === -1 ? null : (blocks[answerIndex] as Extract<UiBlock, { kind: "text" }>).text;
  const isWorking = !!message.streaming && answerIndex === -1;
  const toolCount = timeline.reduce((sum, block) => sum + (block.kind === "tool" ? 1 : 0), 0);
  const durationMs = message.startedAt && message.endedAt ? message.endedAt - message.startedAt : undefined;

  return (
    <div className="msg assistant fadeUp">
      {(timeline.length > 0 || isWorking) && (
        <Reasoning
          blocks={timeline}
          active={isWorking}
          toolCount={toolCount}
          durationMs={durationMs}
        />
      )}
      {answer ? <Markdown text={answer} /> : null}
    </div>
  );
}

function formatDuration(ms?: number): string | null {
  if (!ms || ms < 250) return null;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function Reasoning({
  blocks,
  active,
  toolCount,
  durationMs,
}: {
  blocks: UiBlock[];
  active?: boolean;
  toolCount: number;
  durationMs?: number;
}) {
  const [open, setOpen] = useState(true);
  const duration = formatDuration(durationMs);
  const label = active ? "Working" : "Worked";
  const meta = [
    duration && !active ? `for ${duration}` : null,
    !active && toolCount > 0 ? `· ${toolCount} ${toolCount === 1 ? "tool" : "tools"}` : null,
  ].filter(Boolean).join(" ");
  return (
    <div className={`reasoning ${open ? "open" : ""}`}>
      <button onClick={() => setOpen((v) => !v)} className={active ? "thinking" : "done"}>
        {active && <span className="spinner" />}
        <span className="reasoningLabel">{label}{active ? "…" : ""}</span>
        {meta && <span className="reasoningMeta">{meta}</span>}
      </button>
      {open && blocks.length > 0 && (
        <ol className="timeline">
          {blocks.map((block, index) => {
            if (block.kind === "tool") return <li key={index} className="tl-step tl-step-tool"><ToolCard tool={block.tool} /></li>;
            return (
              <li key={index} className="tl-step tl-step-text">
                <Markdown text={block.text} compact />
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function pickToolIcon(name: string) {
  const n = name.toLowerCase();
  if (n.includes("chart") || n.includes("visual")) return IconChart;
  if (n.includes("sql") || n.includes("db") || n.includes("database")) return IconDb;
  if (n === "bash" || n.includes("shell") || n.includes("terminal")) return IconTerminal;
  if (n.includes("read") || n.includes("write") || n.includes("edit") || n.includes("file")) return IconFile;
  if (n.includes("grep") || n.includes("find") || n.includes("search") || n.includes("web")) return IconSearch;
  return IconCode;
}

function summarizeArgs(args?: Record<string, unknown>) {
  if (!args) return "";
  const candidates = ["query", "sql", "pattern", "path", "file_path", "command", "url", "name"];
  for (const key of candidates) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.length > 96 ? value.slice(0, 93) + "…" : value;
  }
  return "";
}

// Delay before a hover counts as "the user wants to peek." Short enough to
// feel snappy when intentional, long enough to ignore cursor flyovers when
// moving across a stack of tool cards.
const TOOL_HOVER_OPEN_DELAY_MS = 450;

function ToolCard({ tool }: { tool: UiTool }) {
  const Icon = pickToolIcon(tool.name);
  const hint = summarizeArgs(tool.args);
  const hasBody = !!tool.output || !!tool.details;
  const [locked, setLocked] = useState(false);
  const [hovered, setHovered] = useState(false);
  const hoverTimerRef = useRef<number | null>(null);

  function cancelHoverTimer() {
    if (hoverTimerRef.current != null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }
  // Cleanup on unmount so a pending timer doesn't fire after we're gone.
  useEffect(() => () => cancelHoverTimer(), []);

  function handleMouseEnter() {
    cancelHoverTimer();
    hoverTimerRef.current = window.setTimeout(() => {
      setHovered(true);
      hoverTimerRef.current = null;
    }, TOOL_HOVER_OPEN_DELAY_MS);
  }
  function handleMouseLeave() {
    cancelHoverTimer();
    setHovered(false);
  }

  // Hover peeks at the body, click locks it open. Locked overrides hover so
  // the user can drift the cursor away to interact (scroll a chart, click in
  // a table) without the panel slamming shut.
  const open = hasBody && (locked || hovered);
  return (
    <div
      className={`tool ${tool.status} ${open ? "open" : ""} ${locked ? "locked" : ""}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        type="button"
        className="toolHead"
        onClick={() => {
          if (!hasBody) return;
          // Click should pop the panel open instantly — don't make the user
          // wait through the hover delay just because they clicked early.
          cancelHoverTimer();
          setLocked((v) => !v);
        }}
        aria-expanded={hasBody ? open : undefined}
      >
        <Icon size={12} />
        <span className="toolName">{tool.name}</span>
        {hint && <span className="toolHint">{hint}</span>}
        {tool.status === "running" && <span className="toolPulse" />}
        {tool.status === "error" && <span className="toolErr">error</span>}
      </button>
      {hasBody && (
        <div className="toolCollapse" data-open={open ? "true" : "false"}>
          <div className="toolCollapseInner">
            <div className="toolBody">
              {tool.details && <StructuredToolResult details={tool.details} />}
              {tool.output && !tool.details && (
                <div className="toolPanel">
                  <div className="toolPanelHead">output</div>
                  <pre>{tool.output}</pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StructuredToolResult({ details }: { details: ToolResultDetails }) {
  if (details.kind === "database_schema") return <SchemaResult details={details} />;
  if (details.kind === "analytics_visualization") return <VisualizationResult details={details} />;
  return <SqlResult details={details} />;
}

function SqlResult({ details }: { details: Extract<ToolResultDetails, { kind: "sql_result" }> }) {
  const columns = safeColumns(details.columns);
  const rows = safeRows(details.rows);
  return (
    <div className="toolPanel analyticsPanel">
      <AnalyticsHeader
        title={details.title || "SQL result"}
        meta={`${details.rowCount}${details.truncated ? "+" : ""} rows${details.elapsedMs ? ` · ${details.elapsedMs}ms` : ""}`}
      />
      <ResultTable columns={columns} rows={rows} />
      {details.sql && <pre className="analyticsSql">{details.sql}</pre>}
    </div>
  );
}

function SchemaResult({ details }: { details: Extract<ToolResultDetails, { kind: "database_schema" }> }) {
  const schemas = Array.isArray(details.schemas) ? details.schemas : [];
  const tables = Array.isArray(details.tables) ? details.tables : [];
  const rows = tables.map((table) => ({
    schema: table.schema,
    relation: table.name,
    type: table.type,
    rows: table.rowEstimate ?? "",
  }));
  return (
    <div className="toolPanel analyticsPanel">
      <AnalyticsHeader title={details.title || "Database schema"} meta={`${schemas.join(", ")} · ${tables.length} relations`} />
      <ResultTable columns={["schema", "relation", "type", "rows"]} rows={rows} />
    </div>
  );
}

type VizMode = Extract<ToolResultDetails, { kind: "analytics_visualization" }>["chartType"];
type VizFamily = "trend" | "categorical" | "flow";

// Group chart modes by intent. Switching is only allowed *within* a family —
// flipping a trendline to a pie is a category error (different question being
// asked of the data), so we hide cross-family options rather than letting the
// user produce a misleading chart by accident. The original `chartType`
// declared by the visualisation tool decides which family the toggle exposes.
const VIZ_FAMILY: Record<VizMode, VizFamily> = {
  line: "trend",
  area: "trend",
  step: "trend",
  scatter: "trend",
  cumulative: "trend",
  bar: "categorical",
  horizontalBar: "categorical",
  pie: "categorical",
  waterfall: "flow",
};

const VIZ_MODES: ReadonlyArray<{ value: VizMode; label: string; family: VizFamily }> = [
  { value: "line", label: "Line", family: "trend" },
  { value: "area", label: "Area", family: "trend" },
  { value: "step", label: "Step", family: "trend" },
  { value: "scatter", label: "Scatter", family: "trend" },
  { value: "cumulative", label: "Cumulative", family: "trend" },
  { value: "bar", label: "Bar", family: "categorical" },
  { value: "horizontalBar", label: "Horizontal", family: "categorical" },
  { value: "pie", label: "Pie", family: "categorical" },
  { value: "waterfall", label: "Waterfall", family: "flow" },
];

function VisualizationResult({ details }: { details: Extract<ToolResultDetails, { kind: "analytics_visualization" }> }) {
  const rows = safeRows(details.rows);
  const [mode, setMode] = useState<VizMode>(details.chartType);
  const [expanded, setExpanded] = useState(false);
  // Only show alternates that share the original chart's family. The declared
  // `details.chartType` is treated as the source of truth for intent — we
  // never enlarge the menu beyond it, only narrow it to peer alternatives.
  const family = VIZ_FAMILY[details.chartType] ?? "categorical";
  const familyModes = VIZ_MODES.filter((entry) => entry.family === family);

  const card = (onExpandToggle?: () => void, expandIcon?: React.ReactNode) => (
    <div className="toolPanel visualizationPanel">
      <div className="vizCardHead">
        <div className="vizTitle">{details.title || "Visualization"}</div>
        {familyModes.length > 1 && (
          <div className="vizMode" role="group" aria-label="Chart mode">
            {familyModes.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className={mode === value ? "active" : ""}
                onClick={() => setMode(value)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {onExpandToggle && (
          <button type="button" className={expanded ? "vizModalClose" : "vizExpand"} onClick={onExpandToggle} title={expanded ? "Close" : "Expand"} aria-label={expanded ? "Close expanded view" : "Expand"}>
            {expandIcon}
          </button>
        )}
      </div>
      <Suspense fallback={<div className="emptyChart">Loading visualization...</div>}>
        <VisualizationChart details={details} rows={rows} mode={mode} />
      </Suspense>
    </div>
  );

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  return (
    <>
      {card(() => setExpanded(true), <IconExpand size={12} />)}
      {expanded && createPortal(
        <div className="vizModalShade" onClick={() => setExpanded(false)}>
          <div className="vizModalCard" onClick={(event) => event.stopPropagation()}>
            {card(() => setExpanded(false), <IconClose size={14} />)}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function AnalyticsHeader({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="analyticsHead">
      <div className="analyticsTitle">{title}</div>
      <div className="analyticsMeta">{meta}</div>
    </div>
  );
}

function ResultTable({ columns, rows }: { columns: string[]; rows: Array<Record<string, unknown>> }) {
  const visible = rows.slice(0, 80);
  if (!columns.length) return <div className="emptyChart">No tabular columns returned.</div>;
  return (
    <div className="resultTableWrap">
      <table className="resultTable">
        <thead>
          <tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr>
        </thead>
        <tbody>
          {visible.map((row, index) => (
            <tr key={index}>{columns.map((column) => <td key={column}>{formatCell(row[column])}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function safeColumns(columns: Array<{ name: string; dataType?: string }> | undefined) {
  return Array.isArray(columns) ? columns.map((column) => column.name).filter(Boolean) : [];
}

function safeRows(rows: Array<Record<string, unknown>> | undefined) {
  return Array.isArray(rows) ? rows.filter((row): row is Record<string, unknown> => !!row && typeof row === "object") : [];
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// Tiny markdown renderer covering: headings, fenced code blocks, tables,
// ordered & unordered lists, blockquotes, inline code, bold, italics, links,
// hard breaks.
// Compact mode tightens spacing for in-timeline reasoning steps.
function Markdown({ text, compact }: { text: string; compact?: boolean }) {
  return <div className={`answer ${compact ? "compact" : ""}`}>{renderBlocks(text)}</div>;
}

function renderBlocks(input: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block. Allow leading whitespace so fences inside list items
    // (where the model indents the fence under a `- ` bullet) still register.
    // We track the opening indent and strip up to that many leading spaces
    // from each body line, so the content doesn't render with stray indent.
    const fence = /^(\s*)```(\w*)\s*$/.exec(line);
    if (fence) {
      const indent = fence[1].length;
      const lang = fence[2];
      const closing = new RegExp(`^\\s{0,${indent}}\`\`\`\\s*$`);
      const buffer: string[] = [];
      i++;
      while (i < lines.length && !closing.test(lines[i])) {
        buffer.push(indent ? lines[i].replace(new RegExp(`^\\s{0,${indent}}`), "") : lines[i]);
        i++;
      }
      i++;
      out.push(<CodeBlock key={`code-${out.length}`} code={buffer.join("\n")} lang={lang} />);
      continue;
    }

    // Heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const tag = `h${Math.min(level + 2, 6)}` as "h3" | "h4" | "h5" | "h6";
      out.push(React.createElement(tag, { key: `h-${out.length}`, className: "md-heading" }, renderInline(heading[2])));
      i++;
      continue;
    }

    // GitHub-style pipe table
    if (isTableStart(lines, i)) {
      const parsed = parseMarkdownTable(lines, i);
      if (parsed) {
        out.push(<MarkdownTable key={`table-${out.length}`} table={parsed.table} />);
        i = parsed.nextIndex;
        continue;
      }
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      out.push(<ol key={`ol-${out.length}`} className="md-list">{items.map((item, k) => <li key={k}>{renderInline(item)}</li>)}</ol>);
      continue;
    }

    // Unordered list
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*•]\s+/, ""));
        i++;
      }
      out.push(<ul key={`ul-${out.length}`} className="md-list">{items.map((item, k) => <li key={k}>{renderInline(item)}</li>)}</ul>);
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const buffer: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buffer.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(<blockquote key={`q-${out.length}`} className="md-quote">{renderInline(buffer.join("\n"))}</blockquote>);
      continue;
    }

    // Blank line
    if (!line.trim()) { i++; continue; }

    // Paragraph: gather adjacent non-blank, non-special lines
    const buffer: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !isTableStart(lines, i) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*[-*•]\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i])
    ) {
      buffer.push(lines[i]);
      i++;
    }
    const paragraph = buffer.join("\n");
    out.push(<BalancedP key={`p-${out.length}`} text={plainText(paragraph)}>{renderInline(paragraph)}</BalancedP>);
  }
  return out;
}

type MarkdownTableModel = {
  headers: string[];
  alignments: Array<"left" | "center" | "right">;
  rows: string[][];
};

function isTableStart(lines: string[], index: number) {
  return isPipeRow(lines[index]) && isTableDivider(lines[index + 1] ?? "");
}

function isPipeRow(line: string) {
  const trimmed = line.trim();
  return trimmed.includes("|") && /^\|?(.+\|)+.+\|?$/.test(trimmed);
}

function isTableDivider(line: string) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseMarkdownTable(lines: string[], index: number): { table: MarkdownTableModel; nextIndex: number } | null {
  const headers = splitTableRow(lines[index]);
  const divider = splitTableRow(lines[index + 1]);
  if (!headers.length || headers.length !== divider.length || !isTableDivider(lines[index + 1])) return null;
  const alignments = divider.map((cell) => {
    const trimmed = cell.trim();
    if (trimmed.startsWith(":") && trimmed.endsWith(":")) return "center" as const;
    if (trimmed.endsWith(":")) return "right" as const;
    return "left" as const;
  });
  const rows: string[][] = [];
  let nextIndex = index + 2;
  while (nextIndex < lines.length && isPipeRow(lines[nextIndex]) && !isTableDivider(lines[nextIndex])) {
    const cells = splitTableRow(lines[nextIndex]);
    rows.push(headers.map((_, cellIndex) => cells[cellIndex] ?? ""));
    nextIndex++;
  }
  return { table: { headers, alignments, rows }, nextIndex };
}

function splitTableRow(line: string) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const char of trimmed) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function MarkdownTable({ table }: { table: MarkdownTableModel }) {
  return (
    <div className="md-table-wrap">
      <table className="md-table">
        <thead>
          <tr>
            {table.headers.map((header, index) => (
              <th key={index} className={`align-${table.alignments[index]}`}>{renderInline(header)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {table.headers.map((_, cellIndex) => (
                <td key={cellIndex} className={`align-${table.alignments[cellIndex]}`}>{renderInline(row[cellIndex] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Aliases that the model commonly emits in fenced code-block headers but
// which highlight.js doesn't natively recognise as lookup keys. We map them
// to canonical hljs language ids before calling `hljs.highlight`.
const HLJS_LANGUAGE_ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  yml: "yaml",
  md: "markdown",
  rs: "rust",
  text: "plaintext",
  txt: "plaintext",
};

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const requested = (lang || "").toLowerCase();
  const language = HLJS_LANGUAGE_ALIASES[requested] ?? requested;
  let html: string;
  let labelLang = language || "text";
  try {
    if (language && hljs.getLanguage(language)) {
      html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
    } else if (!language) {
      // Auto-detect when the model omitted a language hint. Cheap on small
      // snippets and only runs when content actually changes (each render).
      const auto = hljs.highlightAuto(code);
      html = auto.value;
      labelLang = auto.language || "text";
    } else {
      // Unknown / unsupported language label — render plain but escaped so
      // we don't accidentally inject HTML from streamed model output.
      html = escapeHtml(code);
    }
  } catch {
    html = escapeHtml(code);
  }

  async function copy(event: React.MouseEvent<HTMLButtonElement>) {
    const button = event.currentTarget;
    let ok = false;
    // Modern path. `navigator.clipboard` requires a secure context — true for
    // localhost and https, false for plain http on a LAN address.
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(code);
        ok = true;
      } catch {
        ok = false;
      }
    }
    // Fallback for environments where the async clipboard API is missing or
    // blocked: drop a hidden textarea, select it, and execCommand("copy").
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = code;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        ta.style.pointerEvents = "none";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (ok) {
      // Imperative feedback — the in-header label flips to "Copied" briefly.
      // No sonner here on success: the button itself is the confirmation, and
      // a toast on every copy gets noisy in long sessions.
      const original = button.textContent;
      button.textContent = "Copied";
      button.classList.add("copied");
      window.setTimeout(() => {
        if (button.isConnected) {
          button.textContent = original;
          button.classList.remove("copied");
        }
      }, 1500);
    } else {
      toast.error("Couldn't copy");
    }
  }

  return (
    <div className="md-codeBlock">
      <div className="md-codeBlock-head">
        <span className="md-codeBlock-lang">{labelLang}</span>
        <button type="button" className="md-codeBlock-copy" onClick={copy} title="Copy code">Copy</button>
      </div>
      <pre className="md-code"><code className={`hljs language-${language || "plaintext"}`} dangerouslySetInnerHTML={{ __html: html }} /></pre>
    </div>
  );
}

// Strip inline markdown markers down to their visible text — used as the
// measurement-only string fed to pretext.
function plainText(input: string): string {
  return input
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(\*|_)([^*_\n]+)\1/g, "$2")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// Pretext-balanced paragraph: measures the natural line count at full width,
// then binary-searches the tightest max-width that keeps the line count the
// same. Result: short paragraphs shrink-wrap, no awkward orphan last line.
function BalancedP({ text, children }: { text: string; children: React.ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const preparedRef = useRef<{ key: string; prepared: PreparedTextWithSegments } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !text) return;
    let frame = 0;
    const compute = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const parent = el.parentElement;
        if (!parent) return;
        const containerWidth = parent.getBoundingClientRect().width;
        if (containerWidth < 80) return;
        try {
          const cs = window.getComputedStyle(el);
          const font = `${cs.fontStyle} ${cs.fontVariant} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          const letterSpacing = parsePixelValue(cs.letterSpacing);
          const key = `${text}\u0000${font}\u0000${letterSpacing ?? "normal"}`;
          let prepared = preparedRef.current?.key === key ? preparedRef.current.prepared : undefined;
          if (!prepared) {
            prepared = prepareWithSegments(text, font, letterSpacing === undefined ? undefined : { letterSpacing });
            preparedRef.current = { key, prepared };
          }
          const baseStats = measureLineStats(prepared, containerWidth);
          if (baseStats.lineCount <= 1) {
            el.style.maxWidth = `${Math.ceil(baseStats.maxLineWidth) + 2}px`;
            return;
          }
          let lo = Math.ceil(baseStats.maxLineWidth) + 1;
          let hi = Math.floor(containerWidth);
          for (let i = 0; i < 12 && hi - lo > 2; i++) {
            const mid = Math.floor((lo + hi) / 2);
            if (measureLineStats(prepared, mid).lineCount === baseStats.lineCount) hi = mid;
            else lo = mid;
          }
          el.style.maxWidth = `${hi}px`;
        } catch {
          // Canvas measurement may fail in headless / non-browser contexts.
        }
      });
    };
    compute();
    const observer = new ResizeObserver(compute);
    if (el.parentElement) observer.observe(el.parentElement);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [text]);
  return <p ref={ref}>{children}</p>;
}

function parsePixelValue(value: string) {
  if (!value || value === "normal") return undefined;
  const numeric = Number.parseFloat(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

const INLINE_TOKEN = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\)|\bhttps?:\/\/\S+)/g;

function renderInline(input: string): React.ReactNode[] {
  // Soft breaks: turn lone `\n` inside a paragraph into <br />
  const segments = input.split(/(\n)/);
  const out: React.ReactNode[] = [];
  segments.forEach((segment, segIndex) => {
    if (segment === "\n") { out.push(<br key={`br-${segIndex}`} />); return; }
    if (!segment) return;
    const parts = segment.split(INLINE_TOKEN);
    parts.forEach((part, idx) => {
      const key = `${segIndex}-${idx}`;
      if (!part) return;
      if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
        out.push(<code key={key}>{part.slice(1, -1)}</code>);
      } else if ((part.startsWith("**") && part.endsWith("**")) || (part.startsWith("__") && part.endsWith("__"))) {
        out.push(<strong key={key}>{part.slice(2, -2)}</strong>);
      } else if ((part.startsWith("*") && part.endsWith("*") && part.length > 2) || (part.startsWith("_") && part.endsWith("_") && part.length > 2)) {
        out.push(<em key={key}>{part.slice(1, -1)}</em>);
      } else if (/^\[[^\]]+\]\([^)]+\)$/.test(part)) {
        const match = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
        if (match) {
          out.push(<a key={key} href={match[2]} target="_blank" rel="noreferrer noopener">{match[1]}</a>);
          return;
        }
        out.push(<React.Fragment key={key}>{part}</React.Fragment>);
      } else if (/^https?:\/\/\S+$/.test(part)) {
        out.push(<a key={key} href={part} target="_blank" rel="noreferrer noopener">{part}</a>);
      } else {
        out.push(<React.Fragment key={key}>{part}</React.Fragment>);
      }
    });
  });
  return out;
}

type MentionKind = "command" | "skill" | "file";
type MentionItem = { kind: MentionKind; insert: string; label: string; description?: string; group?: string };
type MentionState = { trigger: "/" | "$" | "@"; start: number; end: number; query: string };

// Spot a trigger immediately preceded by start-of-text or whitespace, capturing
// any wordy / dotted / dashed / slashed body that follows. We re-run this
// against the textarea's value+selection on every change so deleting back
// past the trigger character cleanly closes the menu.
const MENTION_RX = /(^|\s)([/$@])([\w./:\-]*)$/;

function detectMention(value: string, caret: number): MentionState | null {
  const upToCaret = value.slice(0, caret);
  const match = MENTION_RX.exec(upToCaret);
  if (!match) return null;
  const trigger = match[2] as MentionState["trigger"];
  const query = match[3] ?? "";
  // start is the index of the trigger character itself (not the leading whitespace/newline).
  const start = upToCaret.length - (1 + query.length);
  return { trigger, start, end: caret, query };
}

function rankSuggestions<T extends { label: string; description?: string }>(items: T[], query: string, max = 8): T[] {
  if (!query) return items.slice(0, max);
  const q = query.toLowerCase();
  // Three-tier ranking: prefix on label > substring on label > substring on
  // description. Stable within each tier so a sensible order is preserved.
  const buckets: T[][] = [[], [], []];
  for (const item of items) {
    const label = item.label.toLowerCase();
    const desc = item.description?.toLowerCase();
    if (label.startsWith(q)) buckets[0].push(item);
    else if (label.includes(q)) buckets[1].push(item);
    else if (desc?.includes(q)) buckets[2].push(item);
  }
  return [...buckets[0], ...buckets[1], ...buckets[2]].slice(0, max);
}

function Composer({
  state,
  connection,
  value,
  onValueChange,
  onSend,
  onSteer,
  onFollowUp,
  onAbort,
  onThinking,
  models,
  onSetModel,
  resources,
  files,
}: {
  state: PiState | null;
  connection: string;
  value: string;
  onValueChange: (value: string) => void;
  onSend: (text: string) => void;
  onSteer: (text: string) => void;
  onFollowUp: (text: string) => void;
  onAbort: () => void;
  onThinking: (level: PiState["thinkingLevel"]) => void;
  models: PiModelSummary[];
  onSetModel: (provider: string, modelId: string) => void;
  resources: PiResourceSummary | null;
  files: string[];
}) {
  const disabled = connection !== "open";
  const pct = state?.usage?.percent ?? 0;
  // The "context %" bar reflects how much of the active model's context
  // window is currently occupied. The server reads `usage` off the most
  // recent assistant message: `percent = round(tokens / contextWindow * 100)`,
  // where `tokens = usage.totalTokens ?? usage.input`. So it's an estimate of
  // *prompt* size going into the next call (output/cached counts roll into
  // totalTokens when the provider reports them), capped at 100. It updates
  // every time pi emits a new `state` packet (e.g. after each turn settles).
  const thinkingLevels: PiState["thinkingLevel"][] = ["off", "minimal", "low", "medium", "high", "xhigh"];
  const currentThinking = state?.thinkingLevel ?? "off";
  function cycleThinking() {
    const idx = thinkingLevels.indexOf(currentThinking);
    const next = thinkingLevels[(idx + 1) % thinkingLevels.length];
    onThinking(next);
  }

  const availableModels = models.filter((m) => m.available);
  const modelOptions = availableModels.length
    ? availableModels
    : (state?.model
        ? [{ provider: state.model.provider, id: state.model.id, name: state.model.name, available: true, current: true } as PiModelSummary]
        : []);
  const currentModelKey = state?.model ? `${state.model.provider}::${state.model.id}` : "";
  // Native <select> tends to size to the *widest* option in the list (so a
  // short model like "GPT-5.5" still leaves a gap before the next pill).
  // Compute the visible label and feed its char count to CSS so the select
  // shrink-wraps to just what's currently selected.
  const currentModelLabel =
    modelOptions.find((model) => `${model.provider}::${model.id}` === currentModelKey)?.name
    ?? state?.model?.name
    ?? state?.model?.id
    ?? "No model";

  function submit(mode: "send" | "steer" | "followUp" = "send") {
    if (!value.trim() || disabled) return;
    if (mode === "steer") onSteer(value.trim());
    else if (mode === "followUp") onFollowUp(value.trim());
    else onSend(value.trim());
    onValueChange("");
  }

  // Mention popover state — only one is open at a time. `mention` describes
  // the active trigger token; `mentionIndex` is the keyboard-highlighted item.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const suggestions: MentionItem[] = (() => {
    if (!mention) return [];
    if (mention.trigger === "/") {
      // Built-in + extension commands + prompt templates. Skills are exposed
      // via the dollar trigger, so strip the `skill:` items here to keep the
      // slash menu about commands only.
      const rawCmds = (resources?.commands ?? []).filter((c) => !c.name.startsWith("skill:"));
      const items: MentionItem[] = rawCmds.map((c) => ({
        kind: "command",
        insert: `/${c.name}`,
        label: c.name,
        description: c.description,
        group: c.source === "builtin" ? "Built-in" : c.source === "prompt" ? "Prompts" : "Extensions",
      }));
      return rankSuggestions(items, mention.query, 10);
    }
    if (mention.trigger === "$") {
      const skills = resources?.skills ?? [];
      const items: MentionItem[] = skills.map((s) => ({
        kind: "skill",
        insert: `$${s.name}`,
        label: s.name,
        description: s.description,
        group: "Skills",
      }));
      return rankSuggestions(items, mention.query, 10);
    }
    // @file — match against full path so users can type a partial directory.
    const items: MentionItem[] = files.map((p) => ({ kind: "file", insert: `@${p}`, label: p, group: "Files" }));
    return rankSuggestions(items, mention.query, 10);
  })();

  // Reset the highlighted index whenever the suggestions list changes shape.
  useEffect(() => { setMentionIndex(0); }, [mention?.trigger, mention?.query, suggestions.length]);

  function applySuggestion(item: MentionItem) {
    if (!mention) return;
    const insert = item.insert + (item.kind === "file" ? " " : " ");
    const next = value.slice(0, mention.start) + insert + value.slice(mention.end);
    const caret = mention.start + insert.length;
    onValueChange(next);
    setMention(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(caret, caret);
    });
  }

  function handleChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = event.target.value;
    onValueChange(next);
    const caret = event.target.selectionStart ?? next.length;
    setMention(detectMention(next, caret));
  }

  function handleSelect(event: React.SyntheticEvent<HTMLTextAreaElement>) {
    // Pure cursor moves (no value change) need to recompute too — clicking
    // earlier in the input should reopen / close the menu accordingly.
    const ta = event.currentTarget;
    setMention(detectMention(ta.value, ta.selectionStart ?? ta.value.length));
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mention && suggestions.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex((idx) => (idx + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex((idx) => (idx - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        applySuggestion(suggestions[mentionIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit(state?.isStreaming ? "followUp" : "send");
    }
  }

  return (
    <footer className="composerWrap">
      <div className="composer">
        <button className="add" title="Attach"><IconPlusSlim size={16} /></button>
        <textarea
          ref={textareaRef}
          value={value}
          disabled={disabled}
          onChange={handleChange}
          onSelect={handleSelect}
          onBlur={() => window.setTimeout(() => setMention(null), 120)}
          placeholder={disabled ? "Connecting to Pi…" : state?.isStreaming ? "Steer this turn or queue a follow-up…" : "Ask Pi to work in this OS workspace…  (try /, $, @)"}
          rows={1}
          onKeyDown={handleKeyDown}
        />
        {state?.isStreaming ? <button className="send stop" onClick={onAbort} title="Abort"><IconStop /></button> : <button className="send" onClick={() => submit()} title="Send"><IconArrowUpSlim size={16} /></button>}
        {mention && suggestions.length > 0 && (
          <MentionPopover
            trigger={mention.trigger}
            items={suggestions}
            highlightedIndex={mentionIndex}
            onHover={setMentionIndex}
            onPick={applySuggestion}
          />
        )}
      </div>
      {state?.isStreaming && (
        <div className="queueActions">
          <button onClick={() => submit("steer")}>Steer now</button>
          <button onClick={() => submit("followUp")}>Queue after</button>
          <span>{state.pending.steering.length} steering · {state.pending.followUp.length} follow-up</span>
        </div>
      )}
      <div className="metaBar">
        <span className={`status ${connection}`}>{connection}</span>
        <select
          className="metaBar-model"
          value={currentModelKey}
          onChange={(event) => {
            const [provider, modelId] = event.target.value.split("::");
            if (provider && modelId) onSetModel(provider, modelId);
          }}
          disabled={modelOptions.length === 0}
          title="Switch model"
          style={{ ["--label-len" as string]: currentModelLabel.length } as React.CSSProperties}
        >
          {modelOptions.length === 0 && <option value="">No model</option>}
          {modelOptions.map((model) => (
            <option key={`${model.provider}::${model.id}`} value={`${model.provider}::${model.id}`}>
              {model.name ?? model.id}
            </option>
          ))}
        </select>
        <button
          className="metaBar-thinking"
          onClick={cycleThinking}
          title={`Reasoning effort: ${currentThinking} (click to cycle)`}
        >
          {currentThinking}
        </button>
        <span className="ctx" title={state?.usage?.tokens != null && state?.usage?.contextWindow ? `${state.usage.tokens.toLocaleString()} / ${state.usage.contextWindow.toLocaleString()} tokens used in the model's context window` : "Context usage will appear after the first turn"}>
          <span style={{ width: `${pct}%` }} />{pct || 0}%
        </span>
      </div>
    </footer>
  );
}

function MentionPopover({
  trigger,
  items,
  highlightedIndex,
  onHover,
  onPick,
}: {
  trigger: "/" | "$" | "@";
  items: MentionItem[];
  highlightedIndex: number;
  onHover: (index: number) => void;
  onPick: (item: MentionItem) => void;
}) {
  // `onMouseDown` (not click) so we apply *before* the textarea blurs, which
  // would otherwise dismiss the popover and swallow the click.
  const heading = trigger === "/" ? "Commands" : trigger === "$" ? "Skills" : "Files";
  return (
    <div className="mention" role="listbox" aria-label={heading}>
      <div className="mention-head">{heading}</div>
      <ul className="mention-list">
        {items.map((item, index) => (
          <li
            key={`${item.kind}-${item.insert}`}
            role="option"
            aria-selected={index === highlightedIndex}
            className={`mention-item${index === highlightedIndex ? " active" : ""}`}
            onMouseEnter={() => onHover(index)}
            onMouseDown={(event) => { event.preventDefault(); onPick(item); }}
          >
            <span className="mention-label">{item.label}</span>
            {item.description && <span className="mention-desc">{item.description}</span>}
            {item.group && <span className="mention-group">{item.group}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

const SESSIONS_INITIAL_LIMIT = 5;

function LeftSidebar({
  open,
  onToggle,
  onNewSession,
  onOpenWorkspace,
  onSwitchWorkspace,
  onRemoveWorkspace,
  onSwitchSession,
  onDeleteSession,
  workspaces,
  activeWorkspaceId,
  sessions,
  activeSessionId,
  dark,
  onToggleDark,
  models,
  currentModel,
  settings,
  onUpdateSettings,
}: {
  open: boolean;
  onToggle: () => void;
  onNewSession: () => void;
  onOpenWorkspace: () => void;
  onSwitchWorkspace: (workspaceId: string) => void;
  onRemoveWorkspace: (workspaceId: string) => void;
  onSwitchSession: (sessionPath: string) => void;
  onDeleteSession: (sessionPath: string) => void;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  sessions: PiSessionInfo[];
  activeSessionId?: string;
  dark: boolean;
  onToggleDark: () => void;
  models: PiModelSummary[];
  currentModel: PiState["model"];
  settings: PiSettings | null;
  onUpdateSettings: (patch: Partial<PiSettings>) => void;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(() => new Set());
  function confirmDelete(session: PiSessionInfo) {
    const label = session.name || session.firstMessage || "Untitled";
    toast(`Delete "${label}"?`, {
      description: "This conversation file will be permanently removed.",
      duration: 8000,
      action: {
        label: "Delete",
        onClick: () => onDeleteSession(session.path),
      },
      cancel: { label: "Cancel", onClick: () => undefined },
    });
  }

  function confirmRemoveWorkspace(workspace: Workspace) {
    toast(`Remove "${workspace.name}" from sidebar?`, {
      description: "Conversations stay on disk; you can re-open the folder anytime.",
      duration: 8000,
      action: {
        label: "Remove",
        onClick: () => onRemoveWorkspace(workspace.id),
      },
      cancel: { label: "Cancel", onClick: () => undefined },
    });
  }

  const q = query.trim().toLowerCase();
  const filteredSessions = q
    ? sessions.filter((session) => `${session.name ?? ""} ${session.firstMessage} ${session.path}`.toLowerCase().includes(q))
    : sessions;

  function toggleWorkspace(id: string) {
    if (id !== activeWorkspaceId) {
      onSwitchWorkspace(id);
      setCollapsed((prev) => { const next = new Set(prev); next.delete(id); return next; });
      return;
    }
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleExpanded(workspaceId: string) {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  }

  return (
    <aside className={`sidebar left ${open ? "open" : "closed"}`}>
      <div className="sideInner">
        <div className="sideHead">
          <span className="brand">
            <span className="dot" />
            <span>piui</span>
          </span>
          <button className="sideHead-btn" onClick={onToggle} title="Hide sidebar">
            <IconSidebarLeft size={14} />
          </button>
        </div>

        <button className="sb-new" onClick={onNewSession} title="Start a new session">
          <span>New chat</span>
        </button>

        <label className="sb-search">
          <IconSearch size={12} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sessions" />
        </label>

        <div className="sb-scroll">
          <div className="sb-section-label">
            <span>Workspaces</span>
            <button className="sb-section-label-action" onClick={onOpenWorkspace} title="Open workspace">
              <IconPlusSlim size={12} />
            </button>
          </div>

          {workspaces.length === 0 ? (
            <p className="sb-empty">No workspaces yet.</p>
          ) : (
            workspaces.map((workspace) => {
              const isActive = workspace.id === activeWorkspaceId;
              const isOpen = isActive && !collapsed.has(workspace.id);
              const wsSessions = isActive ? filteredSessions : [];
              const expanded = expandedSessions.has(workspace.id);
              const visible = expanded || q ? wsSessions : wsSessions.slice(0, SESSIONS_INITIAL_LIMIT);
              const hiddenCount = wsSessions.length - visible.length;
              return (
                <div key={workspace.id} className={`sb-ws ${isActive ? "active" : ""} ${isOpen ? "open" : "closed"}`}>
                  <div className="sb-ws-row">
                    <button className="sb-ws-head" onClick={() => toggleWorkspace(workspace.id)} title={workspace.cwd}>
                      <IconChev className="sb-chev" size={11} />
                      <IconFolder className="sb-folder" size={13} />
                      <span className="sb-ws-name">{workspace.name}</span>
                      {isActive && wsSessions.length > 0 && <span className="sb-ws-count">{wsSessions.length}</span>}
                    </button>
                    {!workspace.pinned && (
                      <button
                        className="sb-ws-del"
                        title="Remove workspace from sidebar"
                        aria-label="Remove workspace"
                        onClick={(event) => { event.stopPropagation(); confirmRemoveWorkspace(workspace); }}
                      >
                        <IconClose size={12} />
                      </button>
                    )}
                  </div>
                  <div className="sb-ws-body">
                    <div className="sb-ws-body-inner">
                      {isActive && (
                        <div className="sb-convs">
                          {wsSessions.length === 0 ? (
                            <p className="sb-empty">No sessions yet.</p>
                          ) : (
                            <>
                              {visible.map((session) => (
                                <div key={session.path} className={`sb-conv-row ${session.id === activeSessionId ? "active" : ""}`}>
                                  <button
                                    className="sb-conv"
                                    onClick={() => onSwitchSession(session.path)}
                                    title={session.path}
                                  >
                                    <span className="sb-conv-title">{session.name || session.firstMessage || "Untitled"}</span>
                                    <span className="sb-conv-time">{relativeTime(session.modified)}</span>
                                  </button>
                                  <button
                                    className="sb-conv-del"
                                    title="Delete conversation"
                                    aria-label="Delete conversation"
                                    onClick={(event) => { event.stopPropagation(); confirmDelete(session); }}
                                  >
                                    <IconClose size={12} />
                                  </button>
                                </div>
                              ))}
                              {hiddenCount > 0 && (
                                <button className="sb-show-more" onClick={() => toggleExpanded(workspace.id)}>
                                  Show {hiddenCount} more
                                </button>
                              )}
                              {expanded && wsSessions.length > SESSIONS_INITIAL_LIMIT && !q && (
                                <button className="sb-show-more" onClick={() => toggleExpanded(workspace.id)}>
                                  Show less
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="sb-foot">
          <button className="sb-foot-btn" onClick={() => setSettingsOpen(true)}>
            <IconSettings size={14} />
            <span>Settings</span>
          </button>
        </div>
      </div>

      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          dark={dark}
          onToggleDark={onToggleDark}
          models={models}
          currentModel={currentModel}
          settings={settings}
          onUpdateSettings={onUpdateSettings}
        />
      )}

    </aside>
  );
}

function SettingsDialog({
  onClose,
  dark,
  onToggleDark,
  models,
  currentModel,
  settings,
  onUpdateSettings,
}: {
  onClose: () => void;
  dark: boolean;
  onToggleDark: () => void;
  models: PiModelSummary[];
  currentModel: PiState["model"];
  settings: PiSettings | null;
  onUpdateSettings: (patch: Partial<PiSettings>) => void;
}) {
  const availableModels = models.filter((m) => m.available);
  const fallbackModels = currentModel ? [{ provider: currentModel.provider, id: currentModel.id, name: currentModel.name, available: true, current: true } as PiModelSummary] : [];
  const modelOptions = availableModels.length ? availableModels : fallbackModels;

  function modelKey(ref: { provider: string; id?: string; modelId?: string } | null | undefined) {
    if (!ref) return "";
    const id = "id" in ref ? ref.id : (ref as { modelId?: string }).modelId;
    return ref.provider && id ? `${ref.provider}::${id}` : "";
  }
  function parseModelKey(key: string): { provider: string; modelId: string } | null {
    if (!key) return null;
    const [provider, modelId] = key.split("::");
    return provider && modelId ? { provider, modelId } : null;
  }

  const titleKey = modelKey(settings?.titleModel ?? null);
  const defaultKey = modelKey(settings?.defaultModel ?? null);

  const thinkingLevels: PiThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

  return (
    <div className="modalShade" onClick={onClose}>
      <div className="dialog settingsDialog" onClick={(event) => event.stopPropagation()}>
        <div className="dialogHeader">
          <h2>Settings</h2>
          <button className="iconBtn" onClick={onClose} aria-label="Close settings"><IconClose size={14} /></button>
        </div>

        <section className="settingsSection">
          <h3>Appearance</h3>
          <div className="settingsRow">
            <label className="settingsLabel">Theme</label>
            <button className="settingsToggle" onClick={onToggleDark}>
              {dark ? <IconSun size={13} /> : <IconMoon size={13} />}
              <span>{dark ? "Light mode" : "Dark mode"}</span>
            </button>
          </div>
        </section>

        <section className="settingsSection">
          <h3>Chat defaults</h3>

          <div className="settingsRow">
            <label className="settingsLabel" htmlFor="def-model">Default model (new chats)</label>
            <select
              id="def-model"
              value={defaultKey}
              onChange={(event) => {
                const ref = parseModelKey(event.target.value);
                onUpdateSettings({ defaultModel: ref });
              }}
            >
              <option value="">Use current selection</option>
              {modelOptions.map((model) => (
                <option key={`${model.provider}::${model.id}`} value={`${model.provider}::${model.id}`}>
                  {model.name ?? model.id} ({model.provider})
                </option>
              ))}
            </select>
          </div>

          <div className="settingsRow">
            <label className="settingsLabel" htmlFor="def-thinking">Default reasoning (new chats)</label>
            <select
              id="def-thinking"
              value={settings?.defaultThinkingLevel ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                onUpdateSettings({ defaultThinkingLevel: value ? (value as PiThinkingLevel) : null });
              }}
            >
              <option value="">Use current selection</option>
              {thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
          </div>
        </section>

        <section className="settingsSection">
          <h3>Conversation titles</h3>
          <p className="settingsHint">Pick which model writes the short title shown in your chat history. Default is whichever model the chat is using.</p>
          <div className="settingsRow">
            <label className="settingsLabel" htmlFor="title-model">Title model</label>
            <select
              id="title-model"
              value={titleKey}
              onChange={(event) => {
                const ref = parseModelKey(event.target.value);
                onUpdateSettings({ titleModel: ref });
              }}
            >
              <option value="">Same as chat model</option>
              {modelOptions.map((model) => (
                <option key={`${model.provider}::${model.id}`} value={`${model.provider}::${model.id}`}>
                  {model.name ?? model.id} ({model.provider})
                </option>
              ))}
            </select>
          </div>
        </section>

        <div className="dialogActions">
          <button className="primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function RightSidebar({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <aside className={`sidebar right ${open ? "open" : "closed"}`}>
      <div className="sideInner">
        <div className="sideHead">
          <div className="sideHead-tabs">
            <button className="sideHead-tab active">Diffs</button>
          </div>
          <button className="sideHead-btn" onClick={onToggle} title="Hide diffs">
            <IconSidebarRight size={14} />
          </button>
        </div>
        <div className="sb-empty-panel">
          <span className="sb-empty-panel-glyph"><IconDiff size={16} /></span>
          <div className="sb-empty-panel-title">No diffs yet</div>
          <div className="sb-empty-panel-sub">File changes Pi makes during this session will show up here.</div>
        </div>
      </div>
    </aside>
  );
}

function relativeTime(iso: string) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ExtensionDialog({ request, onResolve }: { request: ExtensionUiRequest; onResolve: (value: unknown) => void }) {
  const [value, setValue] = useState("");
  const fields = request as Record<string, unknown>;
  const title = typeof fields.title === "string" ? fields.title : "Pi extension";
  const message = typeof fields.message === "string" ? fields.message : undefined;
  const options = Array.isArray(fields.options) ? fields.options.filter((option): option is string => typeof option === "string") : [];
  const placeholder = typeof fields.placeholder === "string" ? fields.placeholder : "";
  const payload = JSON.stringify(request, null, 2);

  return (
    <div className="modalShade">
      <div className="dialog">
        <h2>{title}</h2>
        {message && <p>{message}</p>}
        {request.kind === "select" && (
          <div className="dialogList">
            {options.map((option) => <button key={option} onClick={() => onResolve(option)}>{option}</button>)}
          </div>
        )}
        {(request.kind === "input" || request.kind === "editor") && <textarea value={value} onChange={(event) => setValue(event.target.value)} placeholder={placeholder} autoFocus />}
        {!["confirm", "select", "input", "editor"].includes(request.kind) && <pre>{payload}</pre>}
        <div className="dialogActions">
          <button onClick={() => onResolve(undefined)}>Cancel</button>
          {request.kind === "confirm" && <button onClick={() => onResolve(false)}>No</button>}
          {request.kind === "confirm" && <button className="primary" onClick={() => onResolve(true)}>Yes</button>}
          {(request.kind === "input" || request.kind === "editor") && <button className="primary" onClick={() => onResolve(value)}>Done</button>}
          {!["confirm", "select", "input", "editor"].includes(request.kind) && <button className="primary" onClick={() => onResolve(undefined)}>Close</button>}
        </div>
      </div>
    </div>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root element");
const rootStore = globalThis as typeof globalThis & { __piuiRoot?: ReturnType<typeof createRoot> };
rootStore.__piuiRoot ??= createRoot(rootElement);
rootStore.__piuiRoot.render(<AppErrorBoundary><App /></AppErrorBoundary>);
