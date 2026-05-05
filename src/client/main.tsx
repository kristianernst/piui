import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { measureLineStats, prepareWithSegments } from "@chenglou/pretext";
import {
  IconArrowUp,
  IconBolt,
  IconChev,
  IconCode,
  IconDiff,
  IconFile,
  IconFolder,
  IconMoon,
  IconPlus,
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
  type PiSessionInfo,
  type PiState,
  type Workspace,
} from "./piSocket";
import "./styles.css";
import "./stage3.css";

type UiTool = {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  output?: string;
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

const starters = [
  "Explore this repo and summarize how it works",
  "What changed recently in git?",
  "Find TODOs and suggest a cleanup plan",
  "Run the test suite and explain failures",
];

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
  const outputs = new Map<string, { text: string; isError: boolean }>();
  for (const message of history) {
    if (message.role === "toolResult") {
      const id = String((message as { toolCallId?: unknown }).toolCallId ?? "");
      if (!id) continue;
      outputs.set(id, { text: contentToText(message.content), isError: !!message.isError });
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
      return { kind: "tool", tool: { ...block.tool, output: result.text, status } };
    });
    return { ...message, blocks };
  });
}

function App() {
  const [connection, setConnection] = useState<"connecting" | "open" | "closed">("connecting");
  const [state, setState] = useState<PiState | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<PiSessionInfo[]>([]);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [dark, setDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [notices, setNotices] = useState<Array<{ id: string; message: string; level?: "info" | "warning" | "error" }>>([]);
  const [uiRequest, setUiRequest] = useState<ExtensionUiRequest | null>(null);
  const socketRef = useRef<ReturnType<typeof connectPi> | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.body.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    const socket = connectPi((packet) => {
      if (packet.type === "ready") {
        setState(packet.data.state);
        setWorkspaces(packet.data.workspaces);
        setActiveWorkspaceId(packet.data.activeWorkspaceId);
      }
      if (packet.type === "workspaces") {
        setWorkspaces(packet.data.workspaces);
        setActiveWorkspaceId(packet.data.activeWorkspaceId);
      }
      if (packet.type === "state") setState(packet.data);
      if (packet.type === "sessions") setSessions(packet.data.sessions);
      if (packet.type === "messages") setMessages(hydrateToolOutputs(packet.data.messages, asMessages(packet.data.messages)));
      if (packet.type === "extension_ui_request") setUiRequest(packet.request);
      if (packet.type === "notification") pushNotice(packet.data.message, packet.data.level);
      if (packet.type === "event") applyEvent(packet.event);
      if (packet.type === "response" && !packet.success) {
        setLastError(packet.error ?? "Unknown Pi error");
        pushNotice(packet.error ?? "Unknown Pi error", "error");
      }
    }, setConnection);
    socketRef.current = socket;
    return () => socket.close();
  }, []);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  function pushNotice(message: string, level?: "info" | "warning" | "error") {
    const id = `${Date.now()}-${Math.random()}`;
    setNotices((prev) => [{ id, message, level }, ...prev].slice(0, 3));
    window.setTimeout(() => setNotices((prev) => prev.filter((notice) => notice.id !== id)), 6000);
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
      setLastError(null);
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
      const status = event.type === "tool_execution_end" ? (event.isError ? "error" : "done") : "running";
      setMessages((prev) => updateLastAssistant(prev, (message) => ({
        ...message,
        blocks: (message.blocks ?? []).map((block) =>
          block.kind === "tool" && block.tool.id === event.toolCallId
            ? { ...block, tool: { ...block.tool, output, status } }
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
    const cwd = window.prompt("Absolute path to workspace");
    if (!cwd?.trim()) return;
    setMessages([]);
    socketRef.current?.send({ type: "open_workspace", cwd: cwd.trim() });
  }

  function switchWorkspace(workspaceId: string) {
    setMessages([]);
    setSessions([]);
    socketRef.current?.send({ type: "switch_workspace", workspaceId });
  }

  function switchSession(sessionPath: string) {
    setMessages([]);
    socketRef.current?.send({ type: "switch_session", sessionPath });
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
        onSwitchSession={switchSession}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        sessions={sessions}
        activeSessionId={state?.sessionId}
        dark={dark}
        onToggleDark={() => setDark((v) => !v)}
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

        <div className="thread" ref={threadRef}>
          {messages.length === 0 ? <EmptyState onPick={sendPrompt} /> : messages.map((message) => <MessageView key={message.id} message={message} />)}
        </div>

        {lastError && <div className="errorToast">{lastError}</div>}
        <NoticeStack notices={notices} />
        <Composer
          state={state}
          connection={connection}
          value={draft}
          onValueChange={setDraft}
          onSend={sendPrompt}
          onSteer={(text) => queuePrompt(text, "steer")}
          onFollowUp={(text) => queuePrompt(text, "follow_up")}
          onAbort={abort}
          onCycleModel={() => socketRef.current?.send({ type: "cycle_model" })}
          onThinking={(level) => socketRef.current?.send({ type: "set_thinking_level", level })}
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

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <section className="empty fadeUp">
      <div className="heroDot"><IconBolt /></div>
      <h1>Pi, in the browser.</h1>
      <p>This local web app talks to Pi through its Node SDK, so it uses your real Pi config, credentials, sessions, tools, context files, extensions, and working directory.</p>
      <div className="suggestions">
        {starters.map((starter) => <button key={starter} onClick={() => onPick(starter)}>{starter}</button>)}
      </div>
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
  if (n === "bash" || n.includes("shell") || n.includes("terminal")) return IconTerminal;
  if (n.includes("read") || n.includes("write") || n.includes("edit") || n.includes("file")) return IconFile;
  if (n.includes("grep") || n.includes("find") || n.includes("search") || n.includes("web")) return IconSearch;
  return IconCode;
}

function summarizeArgs(args?: Record<string, unknown>) {
  if (!args) return "";
  const candidates = ["query", "pattern", "path", "file_path", "command", "url", "name"];
  for (const key of candidates) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.length > 96 ? value.slice(0, 93) + "…" : value;
  }
  return "";
}

function ToolCard({ tool }: { tool: UiTool }) {
  const Icon = pickToolIcon(tool.name);
  const hint = summarizeArgs(tool.args);
  const hasBody = !!(tool.args && Object.keys(tool.args).length) || !!tool.output;
  return (
    <details className={`tool ${tool.status}`}>
      <summary>
        <Icon size={12} />
        <span className="toolName">{tool.name}</span>
        {hint && <span className="toolHint">{hint}</span>}
        {tool.status === "running" && <span className="toolPulse" />}
        {tool.status === "error" && <span className="toolErr">error</span>}
      </summary>
      {hasBody && (
        <div className="toolBody">
          {tool.args && Object.keys(tool.args).length > 0 && (
            <div className="toolPanel">
              <div className="toolPanelHead">arguments</div>
              <pre>{JSON.stringify(tool.args, null, 2)}</pre>
            </div>
          )}
          {tool.output && (
            <div className="toolPanel">
              <div className="toolPanelHead">output</div>
              <pre>{tool.output}</pre>
            </div>
          )}
        </div>
      )}
    </details>
  );
}

// Tiny markdown renderer covering: headings, fenced code blocks, ordered &
// unordered lists, blockquotes, inline code, bold, italics, links, hard breaks.
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

    // Fenced code block
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1];
      const buffer: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buffer.push(lines[i]);
        i++;
      }
      i++;
      out.push(<pre key={`code-${out.length}`} className={`md-code${lang ? ` lang-${lang}` : ""}`}><code>{buffer.join("\n")}</code></pre>);
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
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i]) &&
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
          const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          const prepared = prepareWithSegments(text, font);
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

function Composer({
  state,
  connection,
  value,
  onValueChange,
  onSend,
  onSteer,
  onFollowUp,
  onAbort,
  onCycleModel,
  onThinking,
}: {
  state: PiState | null;
  connection: string;
  value: string;
  onValueChange: (value: string) => void;
  onSend: (text: string) => void;
  onSteer: (text: string) => void;
  onFollowUp: (text: string) => void;
  onAbort: () => void;
  onCycleModel: () => void;
  onThinking: (level: PiState["thinkingLevel"]) => void;
}) {
  const disabled = connection !== "open";
  const pct = state?.usage?.percent ?? 0;
  const modelName = state?.model?.name ?? state?.model?.id ?? "No model";

  function submit(mode: "send" | "steer" | "followUp" = "send") {
    if (!value.trim() || disabled) return;
    if (mode === "steer") onSteer(value.trim());
    else if (mode === "followUp") onFollowUp(value.trim());
    else onSend(value.trim());
    onValueChange("");
  }

  return (
    <footer className="composerWrap">
      <div className="composer">
        <button className="add" title="Attach"><IconPlus /></button>
        <textarea value={value} disabled={disabled} onChange={(event) => onValueChange(event.target.value)} placeholder={disabled ? "Connecting to Pi…" : state?.isStreaming ? "Steer this turn or queue a follow-up…" : "Ask Pi to work in this OS workspace…"} rows={1} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(state?.isStreaming ? "followUp" : "send"); } }} />
        {state?.isStreaming ? <button className="send stop" onClick={onAbort} title="Abort"><IconStop /></button> : <button className="send" onClick={() => submit()} title="Send"><IconArrowUp /></button>}
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
        <button onClick={onCycleModel}>{modelName}</button>
        <select value={state?.thinkingLevel ?? "off"} onChange={(event) => onThinking(event.target.value as PiState["thinkingLevel"])}>
          {(["off", "minimal", "low", "medium", "high", "xhigh"] as const).map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
        <span className="ctx"><span style={{ width: `${pct}%` }} />{pct || 0}%</span>
      </div>
    </footer>
  );
}

function LeftSidebar({
  open,
  onToggle,
  onNewSession,
  onOpenWorkspace,
  onSwitchWorkspace,
  onSwitchSession,
  workspaces,
  activeWorkspaceId,
  sessions,
  activeSessionId,
  dark,
  onToggleDark,
}: {
  open: boolean;
  onToggle: () => void;
  onNewSession: () => void;
  onOpenWorkspace: () => void;
  onSwitchWorkspace: (workspaceId: string) => void;
  onSwitchSession: (sessionPath: string) => void;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  sessions: PiSessionInfo[];
  activeSessionId?: string;
  dark: boolean;
  onToggleDark: () => void;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);

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
          <IconPlus size={12} />
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
              <IconPlus size={11} />
            </button>
          </div>

          {workspaces.length === 0 ? (
            <p className="sb-empty">No workspaces yet.</p>
          ) : (
            workspaces.map((workspace) => {
              const isActive = workspace.id === activeWorkspaceId;
              const isOpen = isActive && !collapsed.has(workspace.id);
              const wsSessions = isActive ? filteredSessions : [];
              return (
                <div key={workspace.id} className={`sb-ws ${isActive ? "active" : ""} ${isOpen ? "open" : "closed"}`}>
                  <button className="sb-ws-head" onClick={() => toggleWorkspace(workspace.id)} title={workspace.cwd}>
                    <IconChev className="sb-chev" size={11} />
                    <IconFolder className="sb-folder" size={13} />
                    <span className="sb-ws-name">{workspace.name}</span>
                    {isActive && wsSessions.length > 0 && <span className="sb-ws-count">{wsSessions.length}</span>}
                  </button>
                  <div className="sb-ws-body">
                    <div className="sb-ws-body-inner">
                      {isActive && (
                        <div className="sb-convs">
                          {wsSessions.length === 0 ? (
                            <p className="sb-empty">No sessions yet.</p>
                          ) : (
                            wsSessions.map((session) => (
                              <button
                                key={session.path}
                                className={`sb-conv ${session.id === activeSessionId ? "active" : ""}`}
                                onClick={() => onSwitchSession(session.path)}
                                title={session.path}
                              >
                                <span className="sb-conv-title">{session.name || session.firstMessage || "Untitled"}</span>
                                <span className="sb-conv-time">{relativeTime(session.modified)}</span>
                              </button>
                            ))
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
          {settingsOpen && (
            <div className="sb-popover">
              <button className="sb-popover-row" onClick={onToggleDark}>
                {dark ? <IconSun size={14} /> : <IconMoon size={14} />}
                <span>{dark ? "Light mode" : "Dark mode"}</span>
              </button>
            </div>
          )}
          <button className="sb-foot-btn" onClick={() => setSettingsOpen((v) => !v)}>
            <IconSettings size={14} />
            <span>Settings</span>
          </button>
        </div>
      </div>
    </aside>
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

function NoticeStack({ notices }: { notices: Array<{ id: string; message: string; level?: "info" | "warning" | "error" }> }) {
  if (!notices.length) return null;
  return (
    <div className="noticeStack">
      {notices.map((notice) => <div key={notice.id} className={`notice ${notice.level ?? "info"}`}>{notice.message}</div>)}
    </div>
  );
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

createRoot(document.getElementById("root")!).render(<App />);
