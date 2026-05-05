import express from "express";
import http from "node:http";
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
const piCwd = path.resolve(process.env.PIUI_CWD ?? process.cwd());

type ClientCommand = {
  id?: string;
  type:
    | "get_state"
    | "get_messages"
    | "prompt"
    | "steer"
    | "follow_up"
    | "abort"
    | "new_session"
    | "cycle_model"
    | "set_thinking_level";
  message?: string;
  streamingBehavior?: "steer" | "followUp";
  level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
};

type ServerPacket =
  | { type: "ready"; data: unknown }
  | { type: "state"; data: unknown }
  | { type: "messages"; data: unknown }
  | { type: "event"; event: unknown }
  | { type: "response"; id?: string; command: string; success: boolean; data?: unknown; error?: string };

function send(ws: WebSocket, packet: ServerPacket) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(packet));
}

function publicState(session: AgentSession) {
  const model = session.model;
  const messages = session.messages ?? [];
  const assistantMessages = messages.filter((message) => message.role === "assistant") as Array<{
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } };
  }>;
  const latestUsage = [...assistantMessages].reverse().find((message) => message.usage)?.usage;
  const tokenEstimate = latestUsage?.totalTokens ?? latestUsage?.input ?? 0;

  return {
    cwd: piCwd,
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

async function createRuntime() {
  const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd });
    return {
      ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  return createAgentSessionRuntime(factory, {
    cwd: piCwd,
    agentDir: getAgentDir(),
    sessionManager: SessionManager.create(piCwd),
  });
}

async function bindSession(runtime: Awaited<ReturnType<typeof createRuntime>>, ws: WebSocket, unsubscribe?: () => void) {
  unsubscribe?.();
  const session = runtime.session;
  // Runtime-created sessions need extension binding after replacement. This is kept
  // best-effort because SDK typings expose different levels across pi releases.
  await (session as AgentSession & { bindExtensions?: (options: Record<string, never>) => Promise<void> }).bindExtensions?.({});
  const nextUnsubscribe = session.subscribe((event) => {
    send(ws, { type: "event", event });
    if (event.type === "agent_end" || event.type === "queue_update" || event.type === "compaction_end") {
      send(ws, { type: "state", data: publicState(session) });
    }
  });
  send(ws, { type: "state", data: publicState(session) });
  send(ws, { type: "messages", data: { messages: session.messages } });
  return nextUnsubscribe;
}

async function main() {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, cwd: piCwd, mode: isProduction ? "production" : "development" });
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
    let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
    let unsubscribe: (() => void) | undefined;

    try {
      runtime = await createRuntime();
      unsubscribe = await bindSession(runtime, ws, unsubscribe);
      send(ws, { type: "ready", data: publicState(runtime.session) });
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

      if (!runtime) return;
      const session = runtime.session;
      const id = command.id;

      try {
        switch (command.type) {
          case "get_state":
            send(ws, { type: "response", id, command: command.type, success: true, data: publicState(session) });
            break;
          case "get_messages":
            send(ws, { type: "response", id, command: command.type, success: true, data: { messages: session.messages } });
            break;
          case "prompt":
            if (!command.message?.trim()) throw new Error("Missing message");
            send(ws, { type: "response", id, command: command.type, success: true });
            await session.prompt(command.message, { streamingBehavior: command.streamingBehavior });
            send(ws, { type: "state", data: publicState(session) });
            break;
          case "steer":
            if (!command.message?.trim()) throw new Error("Missing message");
            await session.steer(command.message);
            send(ws, { type: "response", id, command: command.type, success: true });
            break;
          case "follow_up":
            if (!command.message?.trim()) throw new Error("Missing message");
            await session.followUp(command.message);
            send(ws, { type: "response", id, command: command.type, success: true });
            break;
          case "abort":
            await session.abort();
            send(ws, { type: "response", id, command: command.type, success: true });
            break;
          case "new_session":
            await runtime.newSession();
            unsubscribe = await bindSession(runtime, ws, unsubscribe);
            send(ws, { type: "response", id, command: command.type, success: true });
            break;
          case "cycle_model": {
            const result = await session.cycleModel();
            send(ws, { type: "response", id, command: command.type, success: true, data: result });
            send(ws, { type: "state", data: publicState(session) });
            break;
          }
          case "set_thinking_level":
            if (!command.level) throw new Error("Missing thinking level");
            session.setThinkingLevel(command.level);
            send(ws, { type: "response", id, command: command.type, success: true });
            send(ws, { type: "state", data: publicState(session) });
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
        send(ws, { type: "state", data: publicState(session) });
      }
    });

    ws.on("close", async () => {
      unsubscribe?.();
      await (runtime as unknown as { dispose?: () => Promise<void> | void })?.dispose?.();
    });
  });

  server.listen(port, () => {
    console.log(`piui listening on http://localhost:${port}`);
    console.log(`Pi cwd: ${piCwd}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
