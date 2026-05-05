import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  IconArrowUp,
  IconBolt,
  IconChart,
  IconCheck,
  IconCode,
  IconDatabase,
  IconFile,
  IconFolder,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSidebarLeft,
  IconSidebarRight,
  IconSpark,
  IconStop,
  IconTerminal,
} from "./icons";
import { connectPi, contentToText, type AgentEvent, type AgentMessage, type PiState } from "./piSocket";
import "./styles.css";

type UiTool = {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  output?: string;
  status: "running" | "done" | "error";
};

type UiMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  thinking?: string;
  tools?: UiTool[];
  streaming?: boolean;
  error?: string;
};

const starters = [
  "Explore this repo and summarize how it works",
  "What changed recently in git?",
  "Find TODOs and suggest a cleanup plan",
  "Run the test suite and explain failures",
];

function asMessages(messages: AgentMessage[]): UiMessage[] {
  const next: UiMessage[] = [];
  messages.forEach((message, index) => {
    if (message.role === "user") {
      next.push({ id: `m-${index}`, role: "user", text: contentToText(message.content) });
      return;
    }
    if (message.role === "assistant") {
      const content = Array.isArray(message.content) ? message.content : [];
      const toolCalls = content
        .filter((block) => block.type === "toolCall")
        .map((block) => ({ id: block.id, name: block.name, args: block.arguments, status: "done" as const }));
      const thinking = content.filter((block) => block.type === "thinking").map((block) => block.thinking).join("\n");
      const textBlocks = content.filter((block) => block.type === "text");
      next.push({ id: `m-${index}`, role: "assistant", text: contentToText(textBlocks), thinking, tools: toolCalls });
      return;
    }
    if (message.role === "bashExecution") next.push({ id: `m-${index}`, role: "system", text: `$ ${message.command}\n${message.output}` });
  });
  return next;
}

function App() {
  const [connection, setConnection] = useState<"connecting" | "open" | "closed">("connecting");
  const [state, setState] = useState<PiState | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [dark, setDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  const [lastError, setLastError] = useState<string | null>(null);
  const socketRef = useRef<ReturnType<typeof connectPi> | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.body.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    const socket = connectPi((packet) => {
      if (packet.type === "ready" || packet.type === "state") setState(packet.data);
      if (packet.type === "messages") setMessages(asMessages(packet.data.messages));
      if (packet.type === "event") applyEvent(packet.event);
      if (packet.type === "response" && !packet.success) setLastError(packet.error ?? "Unknown Pi error");
    }, setConnection);
    socketRef.current = socket;
    return () => socket.close();
  }, []);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  function applyEvent(event: AgentEvent) {
    if (event.type === "agent_start") {
      setMessages((prev) => [...prev, { id: `a-${Date.now()}`, role: "assistant", text: "", thinking: "", tools: [], streaming: true }]);
      setLastError(null);
      return;
    }
    if (event.type === "message_update" && event.assistantMessageEvent) {
      const delta = event.assistantMessageEvent;
      setMessages((prev) => updateLastAssistant(prev, (message) => {
        if (delta.type === "text_delta") message.text += delta.delta ?? "";
        if (delta.type === "thinking_delta") message.thinking = (message.thinking ?? "") + (delta.delta ?? "");
        return message;
      }));
      return;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      setMessages((prev) => updateLastAssistant(prev, (message) => ({ ...message, text: contentToText((event.message as AgentMessage & { content: unknown }).content), streaming: false })));
      return;
    }
    if (event.type === "tool_execution_start" && event.toolCallId && event.toolName) {
      setMessages((prev) => updateLastAssistant(prev, (message) => ({
        ...message,
        tools: [...(message.tools ?? []), { id: event.toolCallId!, name: event.toolName!, args: event.args, status: "running" }],
      })));
      return;
    }
    if ((event.type === "tool_execution_update" || event.type === "tool_execution_end") && event.toolCallId) {
      const output = contentToText(event.result?.content ?? event.partialResult?.content ?? "");
      setMessages((prev) => updateLastAssistant(prev, (message) => ({
        ...message,
        tools: (message.tools ?? []).map((tool) => tool.id === event.toolCallId ? { ...tool, output, status: event.type === "tool_execution_end" ? (event.isError ? "error" : "done") : "running" } : tool),
      })));
      return;
    }
    if (event.type === "agent_end") {
      setMessages((prev) => updateLastAssistant(prev, (message) => ({ ...message, streaming: false })));
    }
  }

  function sendPrompt(text: string) {
    const streamingBehavior = state?.isStreaming ? "followUp" : undefined;
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", text }]);
    socketRef.current?.send({ type: "prompt", message: text, streamingBehavior });
  }

  function abort() {
    socketRef.current?.send({ type: "abort" });
  }

  function newSession() {
    setMessages([]);
    socketRef.current?.send({ type: "new_session" });
  }

  const artifacts = useMemo(() => messages.flatMap((message) => message.tools ?? []).slice(-8).reverse(), [messages]);

  return (
    <div className="shell">
      <LeftSidebar open={leftOpen} onToggle={() => setLeftOpen((v) => !v)} onNewSession={newSession} cwd={state?.cwd} />
      <main className="app">
        <header className="topbar">
          <button className="ghost mobile" onClick={() => setLeftOpen(true)} title="Show sidebar"><IconSidebarLeft /></button>
          <div className="titleBlock">
            <span className="brandMark"><IconSpark size={13} /></span>
            <span>{messages[0]?.text.slice(0, 64) || "New Pi session"}</span>
          </div>
          <div className="topActions">
            <button className="ghost" onClick={() => setDark((v) => !v)}>{dark ? "light" : "dark"}</button>
            <button className="ghost" onClick={() => setRightOpen(true)} title="Show activity"><IconSidebarRight /></button>
          </div>
        </header>

        <div className="thread" ref={threadRef}>
          {messages.length === 0 ? <EmptyState onPick={sendPrompt} /> : messages.map((message) => <MessageView key={message.id} message={message} />)}
        </div>

        {lastError && <div className="errorToast">{lastError}</div>}
        <Composer state={state} connection={connection} onSend={sendPrompt} onAbort={abort} onCycleModel={() => socketRef.current?.send({ type: "cycle_model" })} onThinking={(level) => socketRef.current?.send({ type: "set_thinking_level", level })} />
      </main>
      <RightSidebar open={rightOpen} onToggle={() => setRightOpen((v) => !v)} artifacts={artifacts} state={state} />
    </div>
  );
}

function updateLastAssistant(messages: UiMessage[], updater: (message: UiMessage) => UiMessage): UiMessage[] {
  const next = [...messages];
  let index = next.length - 1;
  while (index >= 0 && next[index].role !== "assistant") index--;
  if (index === -1) next.push(updater({ id: `a-${Date.now()}`, role: "assistant", text: "", tools: [], streaming: true }));
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
  if (message.role === "system") return <pre className="systemMsg">{message.text}</pre>;
  return (
    <div className="msg assistant fadeUp">
      {message.thinking && <Reasoning text={message.thinking} active={message.streaming} />}
      {message.tools?.map((tool) => <ToolCard key={tool.id} tool={tool} />)}
      {message.text ? <MarkdownLite text={message.text} /> : message.streaming ? <span className="thinkingInline">Thinking…</span> : null}
    </div>
  );
}

function Reasoning({ text, active }: { text: string; active?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <div className={`reasoning ${open ? "open" : ""}`}>
      <button onClick={() => setOpen((v) => !v)} className={active ? "thinking" : "done"}>
        <span className="check">{!active && <IconCheck size={10} />}</span>
        <span>{active ? "Thinking…" : "Thought"}</span>
      </button>
      {open && <div className="reasoningBody">{text}</div>}
    </div>
  );
}

function ToolCard({ tool }: { tool: UiTool }) {
  const Icon = tool.name === "bash" ? IconTerminal : tool.name.includes("read") || tool.name.includes("write") || tool.name.includes("edit") ? IconFile : tool.name.includes("grep") || tool.name.includes("find") ? IconSearch : IconCode;
  return (
    <details className={`tool ${tool.status}`} open={tool.status === "running"}>
      <summary><Icon size={13} /><span>{tool.name}</span><i>{tool.status}</i></summary>
      {tool.args && <pre>{JSON.stringify(tool.args, null, 2)}</pre>}
      {tool.output && <pre>{tool.output}</pre>}
    </details>
  );
}

function MarkdownLite({ text }: { text: string }) {
  return <div className="answer">{text.split(/\n\n+/).map((paragraph, index) => <p key={index}>{renderInline(paragraph)}</p>)}</div>;
}

function renderInline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

function Composer({ state, connection, onSend, onAbort, onCycleModel, onThinking }: { state: PiState | null; connection: string; onSend: (text: string) => void; onAbort: () => void; onCycleModel: () => void; onThinking: (level: PiState["thinkingLevel"]) => void }) {
  const [value, setValue] = useState("");
  const disabled = connection !== "open";
  const pct = state?.usage?.percent ?? 0;
  const modelName = state?.model?.name ?? state?.model?.id ?? "No model";

  function submit() {
    if (!value.trim() || disabled) return;
    onSend(value.trim());
    setValue("");
  }

  return (
    <footer className="composerWrap">
      <div className="composer">
        <button className="add" title="Attach"><IconPlus /></button>
        <textarea value={value} disabled={disabled} onChange={(event) => setValue(event.target.value)} placeholder={disabled ? "Connecting to Pi…" : "Ask Pi to work in this OS workspace…"} rows={1} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} />
        {state?.isStreaming ? <button className="send stop" onClick={onAbort}><IconStop /></button> : <button className="send" onClick={submit}><IconArrowUp /></button>}
      </div>
      <div className="metaBar">
        <span className={`status ${connection}`}>{connection}</span>
        <button onClick={onCycleModel}>{modelName}</button>
        <select value={state?.thinkingLevel ?? "off"} onChange={(event) => onThinking(event.target.value as PiState["thinkingLevel"])}>
          {(["off", "minimal", "low", "medium", "high", "xhigh"] as const).map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
        <span className="ctx"><span style={{ width: `${pct}%` }} />context {pct || 0}%</span>
      </div>
    </footer>
  );
}

function LeftSidebar({ open, onToggle, onNewSession, cwd }: { open: boolean; onToggle: () => void; onNewSession: () => void; cwd?: string }) {
  return (
    <aside className={`sidebar left ${open ? "open" : "closed"}`}>
      <div className="sideInner">
        <div className="sideHead"><b><span className="dot" /> piui</b><button onClick={onToggle}><IconSidebarLeft /></button></div>
        <button className="newChat" onClick={onNewSession}><IconPlus size={13} /> New session</button>
        <div className="search"><IconSearch size={12} /><input placeholder="Search soon" disabled /></div>
        <div className="section">Native Pi</div>
        <div className="nativeCard"><IconFolder /><span>{cwd ?? "Loading cwd…"}</span></div>
        <div className="nativeCard"><IconDatabase /><span>~/.pi/agent sessions + auth</span></div>
        <div className="nativeCard"><IconCode /><span>read · bash · edit · write tools</span></div>
        <div className="sideFoot"><button><IconSettings size={14} /> Settings soon</button></div>
      </div>
    </aside>
  );
}

function RightSidebar({ open, onToggle, artifacts, state }: { open: boolean; onToggle: () => void; artifacts: UiTool[]; state: PiState | null }) {
  return (
    <aside className={`sidebar right ${open ? "open" : "closed"}`}>
      <div className="sideInner">
        <div className="sideHead"><b>Activity</b><button onClick={onToggle}><IconSidebarRight /></button></div>
        <div className="sessionCard">
          <span>Session</span>
          <code>{state?.sessionId?.slice(0, 8) ?? "—"}</code>
          <small>{state?.sessionFile ?? "Pi session file will appear after connect."}</small>
        </div>
        <div className="section">Tool calls</div>
        {artifacts.length ? artifacts.map((tool) => <div className="artifact" key={tool.id}><IconChart size={13} /><span>{tool.name}</span><i>{tool.status}</i></div>) : <p className="muted">Tools Pi runs will show up here.</p>}
      </div>
    </aside>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
