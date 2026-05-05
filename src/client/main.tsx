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
import {
  connectPi,
  contentToText,
  type AgentEvent,
  type AgentMessage,
  type ExtensionUiRequest,
  type PiModelSummary,
  type PiResourceSummary,
  type PiSessionInfo,
  type PiState,
  type PiTreeEntry,
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
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<PiSessionInfo[]>([]);
  const [resources, setResources] = useState<PiResourceSummary | null>(null);
  const [models, setModels] = useState<PiModelSummary[]>([]);
  const [tree, setTree] = useState<PiTreeEntry[]>([]);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [dark, setDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [notices, setNotices] = useState<Array<{ id: string; message: string; level?: "info" | "warning" | "error" }>>([]);
  const [extensionStatus, setExtensionStatus] = useState<Record<string, string>>({});
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
      if (packet.type === "messages") setMessages(asMessages(packet.data.messages));
      if (packet.type === "resources") setResources(packet.data);
      if (packet.type === "models") setModels(packet.data.models);
      if (packet.type === "tree") setTree(packet.data.entries);
      if (packet.type === "extension_ui_request") setUiRequest(packet.request);
      if (packet.type === "notification") pushNotice(packet.data.message, packet.data.level);
      if (packet.type === "extension_ui_status") {
        if (packet.data.text === undefined && packet.data.value === undefined) {
          setExtensionStatus((prev) => {
            const next = { ...prev };
            delete next[packet.data.key];
            return next;
          });
        } else if (typeof packet.data.text === "string") {
          setExtensionStatus((prev) => ({ ...prev, [packet.data.key]: packet.data.text! }));
          pushNotice(packet.data.text);
        } else if (typeof packet.data.value === "string") {
          const text = packet.data.value;
          setExtensionStatus((prev) => ({ ...prev, [packet.data.key]: text }));
        }
      }
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
      const content = Array.isArray((event.message as AgentMessage & { content?: unknown }).content) ? (event.message as AgentMessage & { content: unknown[] }).content : [];
      const textBlocks = content.filter((block) => typeof block === "object" && block !== null && "type" in block && block.type === "text");
      setMessages((prev) => updateLastAssistant(prev, (message) => ({ ...message, text: contentToText(textBlocks), streaming: false })));
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

  function sendPrompt(text: string, streamingBehavior?: "steer" | "followUp") {
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

  function continueRecent() {
    setMessages([]);
    socketRef.current?.send({ type: "continue_recent" });
  }

  const artifacts = useMemo(() => messages.flatMap((message) => message.tools ?? []).slice(-8).reverse(), [messages]);
  const sessionTitle = state?.workspace.name ? `${state.workspace.name} / ${state.sessionId.slice(0, 8)}` : "New Pi session";

  return (
    <div className="shell">
      <LeftSidebar
        open={leftOpen}
        onToggle={() => setLeftOpen((v) => !v)}
        onNewSession={newSession}
        onContinueRecent={continueRecent}
        onOpenWorkspace={openWorkspace}
        onSwitchWorkspace={switchWorkspace}
        onSwitchSession={switchSession}
        onClone={() => socketRef.current?.send({ type: "clone" })}
        onCompact={() => socketRef.current?.send({ type: "compact" })}
        onExport={() => socketRef.current?.send({ type: "export_html" })}
        onRename={() => {
          const name = window.prompt("Session name", sessions.find((session) => session.id === state?.sessionId)?.name ?? "");
          if (name !== null) socketRef.current?.send({ type: "set_session_name", name });
        }}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        sessions={sessions}
        cwd={state?.cwd}
      />
      <main className="app">
        <header className="topbar">
          <button className="ghost mobile" onClick={() => setLeftOpen(true)} title="Show sidebar"><IconSidebarLeft /></button>
          <div className="titleBlock">
            <span className="brandMark"><IconSpark size={13} /></span>
            <span>{messages[0]?.text.slice(0, 64) || sessionTitle}</span>
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
      <RightSidebar
        open={rightOpen}
        onToggle={() => setRightOpen((v) => !v)}
        artifacts={artifacts}
        state={state}
        resources={resources}
        models={models}
        tree={tree}
        extensionStatus={extensionStatus}
        onUseResource={(label) => setDraft(`/${label} `)}
        onSetModel={(provider, modelId) => socketRef.current?.send({ type: "set_model", provider, modelId })}
        onFork={(entryId) => socketRef.current?.send({ type: "fork", entryId })}
      />
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
        {state?.isCompacting && <span>compacting</span>}
        {state?.isRetrying && <span>retrying</span>}
        <span className="ctx"><span style={{ width: `${pct}%` }} />context {pct || 0}%</span>
      </div>
    </footer>
  );
}

function LeftSidebar({
  open,
  onToggle,
  onNewSession,
  onContinueRecent,
  onOpenWorkspace,
  onSwitchWorkspace,
  onSwitchSession,
  onClone,
  onCompact,
  onExport,
  onRename,
  workspaces,
  activeWorkspaceId,
  sessions,
  cwd,
}: {
  open: boolean;
  onToggle: () => void;
  onNewSession: () => void;
  onContinueRecent: () => void;
  onOpenWorkspace: () => void;
  onSwitchWorkspace: (workspaceId: string) => void;
  onSwitchSession: (sessionPath: string) => void;
  onClone: () => void;
  onCompact: () => void;
  onExport: () => void;
  onRename: () => void;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  sessions: PiSessionInfo[];
  cwd?: string;
}) {
  const [sessionQuery, setSessionQuery] = useState("");
  const filteredSessions = sessions.filter((session) => `${session.name ?? ""} ${session.firstMessage} ${session.path}`.toLowerCase().includes(sessionQuery.toLowerCase()));

  return (
    <aside className={`sidebar left ${open ? "open" : "closed"}`}>
      <div className="sideInner">
        <div className="sideHead"><b><span className="dot" /> piui</b><button onClick={onToggle}><IconSidebarLeft /></button></div>
        <button className="newChat" onClick={onNewSession}><IconPlus size={13} /> New session</button>
        <button className="newChat secondary" onClick={onContinueRecent}><IconDatabase size={13} /> Continue recent</button>
        <button className="newChat secondary" onClick={onOpenWorkspace}><IconFolder size={13} /> Open workspace</button>
        <div className="sessionActions">
          <button onClick={onClone}>Clone</button>
          <button onClick={onCompact}>Compact</button>
          <button onClick={onRename}>Name</button>
          <button onClick={onExport}>Export</button>
        </div>

        <div className="section">Workspaces</div>
        <div className="workspaceList">
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              className={`workspaceRow ${workspace.id === activeWorkspaceId ? "active" : ""}`}
              onClick={() => workspace.id !== activeWorkspaceId && onSwitchWorkspace(workspace.id)}
              title={workspace.cwd}
            >
              <IconFolder size={13} />
              <span>{workspace.name}</span>
            </button>
          ))}
        </div>

        <div className="section">Sessions</div>
        <label className="search"><IconSearch size={13} /><input value={sessionQuery} onChange={(event) => setSessionQuery(event.target.value)} placeholder="Search sessions" /></label>
        <div className="sessionList">
          {filteredSessions.length ? filteredSessions.map((session) => (
            <button key={session.path} className="sessionRow" onClick={() => onSwitchSession(session.path)} title={session.path}>
              <span>{session.name || session.firstMessage || "Untitled session"}</span>
              <small>{session.messageCount} msgs · {new Date(session.modified).toLocaleDateString()}</small>
            </button>
          )) : <p className="muted">No saved sessions yet.</p>}
        </div>

        <div className="section">Native Pi</div>
        <div className="nativeCard"><IconFolder /><span>{cwd ?? "Loading cwd…"}</span></div>
        <div className="nativeCard"><IconDatabase /><span>~/.pi/agent sessions + auth</span></div>
        <div className="nativeCard"><IconCode /><span>read · bash · edit · write tools</span></div>
        <div className="sideFoot"><button><IconSettings size={14} /> Settings soon</button></div>
      </div>
    </aside>
  );
}

function RightSidebar({
  open,
  onToggle,
  artifacts,
  state,
  resources,
  models,
  tree,
  extensionStatus,
  onUseResource,
  onSetModel,
  onFork,
}: {
  open: boolean;
  onToggle: () => void;
  artifacts: UiTool[];
  state: PiState | null;
  resources: PiResourceSummary | null;
  models: PiModelSummary[];
  tree: PiTreeEntry[];
  extensionStatus: Record<string, string>;
  onUseResource: (label: string) => void;
  onSetModel: (provider: string, modelId: string) => void;
  onFork: (entryId: string) => void;
}) {
  const currentModels = models.filter((model) => model.available || model.current).slice(0, 8);
  const forkEntries = tree.filter((entry) => entry.forkable).slice(-5).reverse();
  const resourceItems = [
    ...(resources?.commands.slice(0, 4).map((command) => ({ label: command.name, detail: command.source })) ?? []),
    ...(resources?.skills.slice(0, 2).map((skill) => ({ label: `skill:${skill.name}`, detail: skill.description ?? "skill" })) ?? []),
    ...(resources?.prompts.slice(0, 2).map((prompt) => ({ label: prompt.name, detail: prompt.description ?? "prompt" })) ?? []),
  ];
  const statusItems = Object.entries(extensionStatus).slice(-3).reverse();

  return (
    <aside className={`sidebar right ${open ? "open" : "closed"}`}>
      <div className="sideInner">
        <div className="sideHead"><b>Activity</b><button onClick={onToggle}><IconSidebarRight /></button></div>
        <div className="sessionCard">
          <span>Session</span>
          <code>{state?.sessionId?.slice(0, 8) ?? "—"}</code>
          <small>{state?.sessionFile ?? "Pi session file will appear after connect."}</small>
        </div>
        <div className="section">Model</div>
        <div className="modelList">
          {currentModels.length ? currentModels.map((model) => (
            <button key={`${model.provider}/${model.id}`} className={`modelRow ${model.current ? "active" : ""}`} onClick={() => onSetModel(model.provider, model.id)}>
              <span>{model.name ?? model.id}</span>
              <small>{model.provider}</small>
            </button>
          )) : <p className="muted">Configured models will show here.</p>}
        </div>
        <div className="section">Tool calls</div>
        {artifacts.length ? artifacts.map((tool) => <div className="artifact" key={tool.id}><IconChart size={13} /><span>{tool.name}</span><i>{tool.status}</i></div>) : <p className="muted">Tools Pi runs will show up here.</p>}
        <div className="section">Resources</div>
        <div className="resourceGrid">
          <div><b>{resources?.commands.length ?? 0}</b><span>commands</span></div>
          <div><b>{resources?.skills.length ?? 0}</b><span>skills</span></div>
          <div><b>{resources?.prompts.length ?? 0}</b><span>prompts</span></div>
          <div><b>{resources?.agentsFiles.length ?? 0}</b><span>context</span></div>
        </div>
        <div className="resourceList">
          {resourceItems.length ? resourceItems.map((item) => (
            <button key={`${item.detail}-${item.label}`} onClick={() => onUseResource(item.label)}>
              <span>/{item.label}</span>
              <small>{item.detail}</small>
            </button>
          )) : <p className="muted">Commands, skills, and prompts will appear after resources load.</p>}
        </div>
        {statusItems.length > 0 && (
          <>
            <div className="section">Extension status</div>
            <div className="statusList">
              {statusItems.map(([key, text]) => <div key={key}><span>{key}</span><small>{text}</small></div>)}
            </div>
          </>
        )}
        <div className="section">Fork points</div>
        <div className="forkList">
          {forkEntries.length ? forkEntries.map((entry) => (
            <button key={entry.id} onClick={() => onFork(entry.id)} title={entry.text}>
              <span>{entry.text || entry.id.slice(0, 8)}</span>
              <small>{new Date(entry.timestamp).toLocaleString()}</small>
            </button>
          )) : <p className="muted">User turns that can be forked will show here.</p>}
        </div>
      </div>
    </aside>
  );
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
