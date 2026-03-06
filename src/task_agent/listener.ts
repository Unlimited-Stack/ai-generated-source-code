import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  dispatchInboundHandshake,
  getWaitingHumanSummary,
  handleWaitingHumanIntent,
  type WaitingHumanIntent
} from "./dispatcher";
import { runTaskStepById } from "./task_loop";
import {
  parseTaskDocument,
  HandshakeInboundEnvelopeSchema,
  type HandshakeInboundEnvelope,
  type HandshakeOutboundEnvelope
} from "./util/schema";
import { listTaskSnapshots, readTaskSnapshot, sqliteHealth, upsertTaskSnapshot } from "./util/sqlite";
import {
  getTaskFilePath,
  listAllTasks,
  readTaskDocument,
  saveTaskMD,
  transitionTaskStatus
} from "./util/storage";


let serverInstance: Server | null = null;

/**
 * Passive flow gateway.
 * Phase 4: HTTP inbound pipeline with safeParse -> dispatcher -> protocol response.
 */
export async function startListener(): Promise<void> {
  if (serverInstance) {
    return;
  }

  serverInstance = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    await handleHttpRequest(req, res);
  });

  await new Promise<void>((resolve) => {
    serverInstance?.listen(8080, "0.0.0.0", () => resolve());
  });
}

/** 停止 HTTP listener（用于退出运行时或从挂起模式返回）。 */
export async function stopListener(): Promise<void> {
  if (!serverInstance) {
    return;
  }

  const instance = serverInstance;
  serverInstance = null;

  await new Promise<void>((resolve, reject) => {
    instance.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/** 当前 listener 是否已启动（仅表示本进程内 serverInstance 是否存在）。 */
export function isListenerRunning(): boolean {
  return serverInstance !== null;
}

export async function handleInboundHandshake(payload: unknown): Promise<HandshakeOutboundEnvelope> {
  const parsed = HandshakeInboundEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    return buildSchemaErrorResponse(payload);
  }

  const envelope: HandshakeInboundEnvelope = parsed.data;
  return dispatchInboundHandshake(envelope);
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const parsedUrl = new URL(req.url ?? "/", "http://localhost");
  const path = parsedUrl.pathname;
  const payload = method === "POST" || method === "PATCH" ? await readJsonBody(req) : {};

  if (method === "POST" && path === "/handshake") {
    const response = await handleInboundHandshake(payload);
    sendJson(res, response.action === "ERROR" ? 400 : 200, response);
    return;
  }

  if (method === "GET" && path === "/tasks") {
    const records = await listAllTasks();
    sendJson(res, 200, {
      tasks: records.map((record) => ({
        task_id: record.task.frontmatter.task_id,
        status: record.task.frontmatter.status,
        hidden: record.task.frontmatter.hidden,
        version: record.task.frontmatter.version,
        updated_at: record.task.frontmatter.updated_at
      }))
    });
    return;
  }

  if (method === "GET" && path === "/sqlite/health") {
    sendJson(res, 200, sqliteHealth());
    return;
  }

  if (method === "GET" && path === "/sqlite/tasks") {
    sendJson(res, 200, { tasks: listTaskSnapshots() });
    return;
  }

  const sqliteTaskMatch = path.match(/^\/sqlite\/tasks\/([^/]+)$/);
  if (method === "GET" && sqliteTaskMatch) {
    const taskId = decodeURIComponent(sqliteTaskMatch[1]);
    const snapshot = readTaskSnapshot(taskId);
    if (!snapshot) {
      sendJson(res, 404, { error: "Task not found in sqlite" });
      return;
    }
    sendJson(res, 200, snapshot);
    return;
  }

  if (method === "POST" && path === "/sqlite/sync-all") {
    const records = await listAllTasks();
    for (const record of records) {
      upsertTaskSnapshot(record.task, record.taskPath);
    }
    sendJson(res, 200, { synced: records.length });
    return;
  }

  if (method === "POST" && path === "/tasks") {
    try {
      const task = parseTaskDocument(payload);
      await saveTaskMD(task);
      sendJson(res, 201, { task_id: task.frontmatter.task_id });
    } catch (error) {
      sendJson(res, 400, { error: normalizeErrorMessage(error) });
    }
    return;
  }

  const taskIdMatch = path.match(/^\/tasks\/([^/]+)$/);
  if (method === "GET" && taskIdMatch) {
    const taskId = decodeURIComponent(taskIdMatch[1]);
    try {
      const task = await readTaskDocument(taskId);
      const summary = task.frontmatter.status === "Waiting_Human" ? await getWaitingHumanSummary(taskId) : null;
      const taskPath = await getTaskFilePath(taskId);
      sendJson(res, 200, { task, waiting_human_summary: summary, task_path: taskPath });
    } catch (error) {
      sendJson(res, 404, { error: normalizeErrorMessage(error) });
    }
    return;
  }

  const taskRunMatch = path.match(/^\/tasks\/([^/]+)\/run$/);
  if (method === "POST" && taskRunMatch) {
    const taskId = decodeURIComponent(taskRunMatch[1]);
    try {
      const changed = await runTaskOnce(taskId);
      const latest = await readTaskDocument(taskId);
      sendJson(res, 200, { changed, task: latest });
    } catch (error) {
      sendJson(res, 400, { error: normalizeErrorMessage(error) });
    }
    return;
  }

  const taskListenerMatch = path.match(/^\/tasks\/([^/]+)\/listener$/);
  if (method === "POST" && taskListenerMatch) {
    const taskId = decodeURIComponent(taskListenerMatch[1]);
    const command = parseTaskListenerCommand(payload);
    if (!command) {
      sendJson(res, 400, { error: "Invalid listener command payload" });
      return;
    }

    try {
      const before = await readTaskDocument(taskId);

      if (command.enabled) {
        // Move to Listening (only valid from Waiting_Human per FSM)
        await transitionTaskStatus(taskId, "Listening", {
          expectedVersion: before.frontmatter.version,
          traceId: "api",
          messageId: "owner"
        });
      } else {
        // Stop listening: back to Waiting_Human, or Cancelled if abandon requested
        const targetStatus = command.abandon ? "Cancelled" : "Waiting_Human";
        await transitionTaskStatus(taskId, targetStatus, {
          expectedVersion: before.frontmatter.version,
          traceId: "api",
          messageId: "owner"
        });
      }

      const latest = await readTaskDocument(taskId);
      sendJson(res, 200, {
        task_id: latest.frontmatter.task_id,
        status: latest.frontmatter.status,
        version: latest.frontmatter.version
      });
    } catch (error) {
      sendJson(res, 400, { error: normalizeErrorMessage(error) });
    }
    return;
  }

  const waitingIntentMatch = path.match(/^\/tasks\/([^/]+)\/waiting-human-intent$/);
  if (method === "POST" && waitingIntentMatch) {
    const taskId = decodeURIComponent(waitingIntentMatch[1]);
    const intent = parseWaitingHumanIntent(payload);
    if (!intent) {
      sendJson(res, 400, { error: "Invalid waiting-human intent" });
      return;
    }
    try {
      const result = await handleWaitingHumanIntent(taskId, intent);
      sendJson(res, 200, {
        ...result,
        listener_running: isListenerRunning(),
        task: await readTaskDocument(taskId)
      });
    } catch (error) {
      sendJson(res, 400, { error: normalizeErrorMessage(error) });
    }
    return;
  }

  if (method === "POST" && path === "/listener/start") {
    await startListener();
    sendJson(res, 200, { running: true });
    return;
  }

  if (method === "POST" && path === "/listener/stop") {
    sendJson(res, 400, {
      error: "Global listener stop is disabled. Use POST /tasks/:id/listener with {\"enabled\":false} instead."
    });
    return;
  }

  if (method === "GET" && path === "/listener/status") {
    sendJson(res, 200, { running: isListenerRunning() });
    return;
  }

  sendJson(res, 404, { error: "Not Found" });
}

async function runTaskOnce(taskId: string): Promise<boolean> {
  const result = await runTaskStepById(taskId);
  return result.changed;
}

function parseWaitingHumanIntent(payload: unknown): WaitingHumanIntent | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const intent = (payload as Record<string, unknown>).intent;
  if (intent === "satisfied" || intent === "unsatisfied" || intent === "enable_listener" || intent === "closed" || intent === "friend_request" || intent === "exit") {
    return intent;
  }
  return null;
}

function parseTaskListenerCommand(payload: unknown): { enabled: boolean; abandon: boolean } | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const enabled = (payload as Record<string, unknown>).enabled;
  const abandonRaw = (payload as Record<string, unknown>).abandon;
  if (typeof enabled !== "boolean") {
    return null;
  }
  return {
    enabled,
    abandon: typeof abandonRaw === "boolean" ? abandonRaw : true
  };
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.statusCode = statusCode;
  res.end(JSON.stringify(body));
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "Internal error";
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (body.length === 0) {
    return {};
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    return {};
  }
}

function buildSchemaErrorResponse(payload: unknown): HandshakeOutboundEnvelope {
  const inReplyTo =
    typeof payload === "object" && payload !== null && typeof (payload as Record<string, unknown>).message_id === "string"
      ? ((payload as Record<string, unknown>).message_id as string)
      : "unknown";

  const taskId =
    typeof payload === "object" && payload !== null && typeof (payload as Record<string, unknown>).task_id === "string"
      ? ((payload as Record<string, unknown>).task_id as string)
      : "unknown";

  return {
    protocol_version: "1.0",
    message_id: randomUUID(),
    in_reply_to: inReplyTo,
    task_id: taskId,
    action: "ERROR",
    error: {
      code: "E_SCHEMA_INVALID",
      message: "Inbound handshake schema validation failed"
    },
    timestamp: new Date().toISOString()
  };
}
