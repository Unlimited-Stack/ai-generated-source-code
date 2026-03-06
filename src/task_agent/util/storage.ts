import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ErrorCode,
  HandshakeInboundEnvelope,
  HandshakeOutboundEnvelope,
  ListeningReport,
  NegotiationSession,
  SessionStatus,
  TaskDocument,
  TaskFrontmatter,
  TaskStatus
} from "./schema";
import { NegotiationSessionSchema, parseHandshakeInboundEnvelope, parseHandshakeOutboundEnvelope, parseTaskDocument } from "./schema";
import { upsertTaskSnapshot } from "./sqlite";

/**
 * 存储/持久化防腐层（Anti-Corruption Layer）。
 *
 * 本模块是任务系统所有"落盘写入"的唯一入口之一（另一个可能是后续的 SQLite/RAG 派生层实现）。
 * 目标：把文件系统细节与上层业务逻辑隔离，避免其他模块随意写 `.data/` 导致耦合与数据污染。
 *
 * 设计约定（相对 `process.cwd()`）：
 * - `.data/task_agents/<task_dir>/task.md`：任务真相源（Single Source of Truth）
 * - `.data/task_agents/<task_dir>/data/raw_chats/`：对话原文快照（按天文件）
 * - `.data/task_agents/<task_dir>/data/agent_chat/`：协议收发 JSONL、scratchpad
 * - `.data/task_agents/<task_dir>/data/embedding_data/`：派生索引/embedding 占位数据
 * - `.data/idempotency_keys.jsonl`：握手幂等键窗口（JSONL，默认 7 天）
 * - `.data/sync_repair_queue.jsonl`：派生层同步失败修复队列（JSONL）
 * - `.data/raw_chats_summary/`：全局摘要（按天覆盖写，便于做日报/摘要）
 * - `.data/logs/`：系统/审计日志（JSONL）
 *
 * 注意：
 * - 本模块大量使用"安全读取"（文件不存在则返回空），因为这些文件多为可重建的派生数据。
 * - 状态迁移采用"两阶段写"：先写 `task.md` 并置 `pending_sync=true`，再同步派生层并清标记。
 */

/**
 * 派生层同步失败后的修复队列条目。
 * 语义：真相源 `task.md` 已写入成功，但 SQLite/RAG 等派生层未同步完成，需要后台重试。
 */
export interface SyncRepairJob {
  taskId: string;
  reason: string;
  createdAt: string;
}

/**
 * 保存/覆盖写入 `task.md` 时的可选参数。
 * - `expectedVersion`：乐观锁版本号（用于避免并发覆盖）。
 */
export interface SaveTaskOptions {
  expectedVersion?: number;
}

/**
 * 状态迁移结果（方便上层写日志/打点/调试）。
 * - `version`：迁移后版本（单调递增）
 * - `updatedAt`：迁移时写入的 `updated_at`（ISO 字符串）
 */
export interface TransitionResult {
  previousStatus: TaskStatus;
  nextStatus: TaskStatus;
  version: number;
  updatedAt: string;
}


/**
 * 状态迁移的可选元信息。
 * - `expectedVersion`：乐观锁；不匹配时抛 `E_VERSION_CONFLICT`
 * - `traceId/messageId`：用于可观测性关联（追踪一次握手/一次任务推进）
 * - `errorCode`：记录业务/系统错误码（可空，用于审计日志）
 */
export interface TransitionOptions {
  expectedVersion?: number;
  traceId?: string;
  messageId?: string;
  errorCode?: ErrorCode | null;
}

/** 扫描到的任务文件与其解析结果（用于遍历 `.data/task_agents/<task_dir>/task.md`）。 */
export interface TaskRecord {
  taskPath: string;
  task: TaskDocument;
}

/**
 * 幂等记录落盘格式（JSONL）。
 * 幂等键规则：`(message_id, sender_agent_id, protocol_version)` 唯一标识一次握手消息。
 */
export interface IdempotencyRecord {
  key: string;
  taskId: string;
  createdAt: string;
  response: HandshakeOutboundEnvelope;
}

/** Agent 间协议报文日志行格式（入站/出站都写，JSONL）。 */
export interface AgentChatLogEntry {
  direction: "inbound" | "outbound";
  timestamp: string;
  payload: unknown;
}

export interface HandshakeExchangeSnapshot {
  /** 最近一次入站握手消息（若不存在则为 null）。 */
  inbound: HandshakeInboundEnvelope | null;
  /** 最近一次出站握手响应（若不存在则为 null）。 */
  outbound: HandshakeOutboundEnvelope | null;
  /** 读取到的 agent_chat 文件路径（若未找到任何文件则为 null）。 */
  sourceFilePath: string | null;
}

/**
 * 系统事件的结构化日志（JSON 行写入 `.data/logs/YYYY-MM-DD-sys.md`）。
 * 用途：审计状态迁移、保留策略清理、索引重建、memory flush 等后台作业。
 */
export interface ObservabilityLogEvent {
  trace_id: string;
  task_id: string;
  message_id: string;
  from_status: TaskStatus | "N/A";
  to_status: TaskStatus | "N/A";
  latency_ms: number;
  error_code: ErrorCode | null;
  event: string;
  timestamp: string;
  details?: Record<string, string | number | boolean>;
}

/** 保留策略清理的统计结果。 */
export interface RetentionCleanupResult {
  deletedRawChats: number;
  deletedAgentChatJsonl: number;
}

/** `.data/` 根目录（派生数据根）。注意：依赖 `process.cwd()`。 */
const DATA_ROOT = path.resolve(process.cwd(), ".data");
/** `.data/task_agents/`：每个任务一个子目录。 */
const TASK_AGENTS_ROOT = path.join(DATA_ROOT, "task_agents");
/** `.data/sync_repair_queue.jsonl`：派生层修复队列（JSONL）。 */
const SYNC_REPAIR_QUEUE_FILE = path.join(DATA_ROOT, "sync_repair_queue.jsonl");
/** `.data/idempotency_keys.jsonl`：幂等键窗口（JSONL）。 */
const IDEMPOTENCY_FILE = path.join(DATA_ROOT, "idempotency_keys.jsonl");
/** 幂等窗口：超过该时间的记录会被裁剪（避免无限增长）。 */
const IDEMPOTENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** `.data/User.md`：本机用户画像/偏好（仅本地研判使用）。 */
const USER_PROFILE_FILE = path.join(DATA_ROOT, "User.md");
/** `.data/raw_chats_summary/`：全局摘要目录（按天覆盖写）。 */
const GLOBAL_RAW_CHAT_SUMMARY_DIR = path.join(DATA_ROOT, "raw_chats_summary");
/** `.data/logs/`：系统/审计日志目录（JSON 行）。 */
const GLOBAL_LOG_DIR = path.join(DATA_ROOT, "logs");
/** raw chat 快照默认保留天数（清理由 `cleanupExpiredData()` 触发）。 */
const RAW_CHATS_RETENTION_DAYS = 90;
/** agent chat JSONL 默认保留天数（清理由 `cleanupExpiredData()` 触发）。 */
const AGENT_CHAT_RETENTION_DAYS = 180;

/** FSM 允许迁移表：`transitionTaskStatus()` 的唯一真源。 */
const ALLOWED_STATUS_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  Drafting: ["Searching", "Cancelled"],
  Searching: ["Negotiating", "Timeout", "Failed", "Cancelled"],
  Negotiating: ["Waiting_Human", "Timeout", "Failed", "Cancelled"],
  Waiting_Human: ["Revising", "Drafting", "Listening", "Closed", "Cancelled"],
  Listening: ["Waiting_Human", "Cancelled"],
  Revising: ["Searching", "Cancelled"],
  Closed: ["Waiting_Human"],
  Failed: ["Searching"],
  Timeout: ["Searching"],
  Cancelled: ["Waiting_Human"]
};

/**
 * 保存/覆盖写入 `task.md`（真相源）。
 *
 * 应用场景：
 * - `src/task_agent/task_loop.ts`：intake 阶段创建初始任务
 * - `tests/state_machine.spec.ts`：状态机测试写入/覆盖任务
 *
 * 注意：
 * - 会先通过 `parseTaskDocument()` 校验 `TaskDocument` 结构（防止脏数据落盘）。
 * - 若传入 `expectedVersion`，会做乐观锁校验；不匹配则抛 `E_VERSION_CONFLICT`。
 */
export async function saveTaskMD(task: TaskDocument, options: SaveTaskOptions = {}): Promise<void> {
  const validated = parseTaskDocument(task);
  const taskPath = await resolveTaskPathByTaskId(validated.frontmatter.task_id, true);
  const currentText = await safeReadText(taskPath);

  if (options.expectedVersion !== undefined && currentText.length > 0) {
    const current = parseTaskMDContent(currentText);
    if (current.frontmatter.version !== options.expectedVersion) {
      throw new Error(
        `E_VERSION_CONFLICT: expected ${options.expectedVersion}, got ${current.frontmatter.version} for ${validated.frontmatter.task_id}`
      );
    }
  }

  if (options.expectedVersion !== undefined && currentText.length === 0) {
    throw new Error(
      `E_VERSION_CONFLICT: expected ${options.expectedVersion}, got missing task for ${validated.frontmatter.task_id}`
    );
  }

  const serialized = serializeTaskMDContent(validated);
  await writeFile(taskPath, serialized, "utf8");
  try {
    await syncDerivedLayers(validated);
  } catch {
    // Creating task.md should not fail because of derived-layer lock/availability issues.
  }
}

/**
 * 仅更新状态的薄封装。
 *
 * 推荐：
 * - 生产路径更推荐直接使用 `transitionTaskStatus()`，以携带 `traceId/messageId/errorCode` 便于审计。
 */
export async function updateTaskStatus(taskId: string, nextStatus: TaskStatus): Promise<void> {
  await transitionTaskStatus(taskId, nextStatus);
}

export async function setTaskHidden(taskId: string, hidden: boolean): Promise<void> {
  const taskPath = await resolveTaskPathByTaskId(taskId);
  const current = await readTaskDocumentByPath(taskPath);

  if (current.frontmatter.hidden === hidden) {
    return;
  }

  const updated = parseTaskDocument({
    frontmatter: {
      ...current.frontmatter,
      hidden,
      updated_at: new Date().toISOString(),
      version: current.frontmatter.version + 1
    },
    body: current.body
  });

  await writeFile(taskPath, serializeTaskMDContent(updated), "utf8");
  try {
    await syncDerivedLayers(updated);
  } catch {
    // Non-critical: derived layer sync failure does not block hide/unhide.
  }
}

/**
 * L0 结构化"硬过滤"候选查询（只基于结构化字段，不做语义计算）。
 *
 * 过滤规则：
 * - 只考虑 `status=Searching` 的任务
 * - `interaction_type` 必须兼容（任意/一致）
 */
export async function queryL0Candidates(_taskId: string): Promise<string[]> {
  const source = await readTaskDocument(_taskId);
  const records = await listAllTaskRecords();
  const sourceInteraction = source.frontmatter.interaction_type;

  const result: string[] = [];
  for (const record of records) {
    const candidate = record.task;
    if (candidate.frontmatter.task_id === _taskId) {
      continue;
    }
    if (candidate.frontmatter.status !== "Searching") {
      continue;
    }

    const candidateInteraction = candidate.frontmatter.interaction_type;
    const interactionCompatible =
      sourceInteraction === "any" || candidateInteraction === "any" || sourceInteraction === candidateInteraction;
    if (!interactionCompatible) {
      continue;
    }

    result.push(candidate.frontmatter.task_id);
  }

  return result;
}

/**
 * 追加一条派生层修复任务到 `sync_repair_queue.jsonl`（JSONL 追加写）。
 *
 * 被使用位置：
 * - `transitionTaskStatus()`：派生层同步失败时入队（不回滚 `task.md`）
 */
export async function enqueueSyncRepair(job: SyncRepairJob): Promise<void> {
  const line = JSON.stringify(job);
  const existing = await safeReadText(SYNC_REPAIR_QUEUE_FILE);
  const nextContent = existing.length === 0 ? `${line}\n` : `${existing.trimEnd()}\n${line}\n`;
  await writeFile(SYNC_REPAIR_QUEUE_FILE, nextContent, "utf8");
}

/**
 * 按 `task_id` 读取并解析 `task.md`（通过扫描目录定位文件）。
 *
 * 被使用位置：
 * - `src/task_agent/dispatcher.ts`：处理入站握手、构建 L1 语义池等
 * - `queryL0Candidates()`：读源任务
 * - `resumeFailedOrTimeoutTask()` / `retrySyncRepairs()`：维护路径
 */
export async function readTaskDocument(taskId: string): Promise<TaskDocument> {
  const taskPath = await resolveTaskPathByTaskId(taskId);
  return readTaskDocumentByPath(taskPath);
}

/**
 * 列出指定状态集合的任务（给 dispatcher/task_loop 做轮询用）。
 *
 * 被使用位置：
 * - `src/task_agent/dispatcher.ts`：挑选 Drafting/Revising/Searching 任务进入下一步处理
 */
export async function listTasksByStatuses(statuses: TaskStatus[]): Promise<TaskDocument[]> {
  const set = new Set(statuses);
  const records = await listAllTaskRecords();
  return records.map((record) => record.task).filter((task) => set.has(task.frontmatter.status));
}

/** 列出本机所有可解析的任务记录（供 runtime/UI 展示用）。 */
export async function listAllTasks(): Promise<TaskRecord[]> {
  return listAllTaskRecords();
}

/**
 * 获取某个任务的 `task.md` 路径（用于提示用户手动编辑/排障）。
 * 注意：该函数会扫描定位；若任务不存在会抛 `E_TASK_NOT_FOUND`。
 */
export async function getTaskFilePath(taskId: string): Promise<string> {
  return resolveTaskPathByTaskId(taskId);
}

/**
 * 任务状态迁移（乐观锁 + 审计 + "先真相源后派生层"两阶段写入）。
 *
 * 核心语义：
 * - Step 1：先写入 `task.md`（真相源）并置 `pending_sync=true`
 * - Step 2：同步派生层（当前阶段占位实现）
 * - Step 3：派生层成功后回写 `pending_sync=false`
 * - 若派生层失败：不回滚 `task.md`，而是入修复队列 + 写审计日志，供后台重试
 *
 * 被使用位置：
 * - `src/task_agent/dispatcher.ts`：驱动主状态机与握手流转
 * - `tests/state_machine.spec.ts`：状态迁移规则测试
 */
export async function transitionTaskStatus(
  taskId: string,
  nextStatus: TaskStatus,
  options: TransitionOptions = {}
): Promise<TransitionResult> {
  const startedAt = Date.now();
  const taskPath = await resolveTaskPathByTaskId(taskId);
  const current = await readTaskDocumentByPath(taskPath);
  const previousStatus = current.frontmatter.status;

  if (options.expectedVersion !== undefined && current.frontmatter.version !== options.expectedVersion) {
    throw new Error(
      `E_VERSION_CONFLICT: expected ${options.expectedVersion}, got ${current.frontmatter.version} for ${taskId}`
    );
  }

  assertTransitionAllowed(previousStatus, nextStatus);

  const nowIso = new Date().toISOString();
  const nextVersion = current.frontmatter.version + 1;
  const step1Doc = parseTaskDocument({
    frontmatter: {
      ...current.frontmatter,
      status: nextStatus,
      entered_status_at: nowIso,
      updated_at: nowIso,
      version: nextVersion,
      pending_sync: true
    },
    body: current.body
  });

  // Step 1：先落盘真相源（不依赖派生层是否可用）。
  await writeFile(taskPath, serializeTaskMDContent(step1Doc), "utf8");

  try {
    // Step 2：同步派生层（SQLite / RAG 等），本阶段为占位实现。
    await syncDerivedLayers(step1Doc);

    // Step 3：派生层同步成功后清理 `pending_sync`（表示"已完全一致"）。
    const step3Doc = parseTaskDocument({
      frontmatter: {
        ...step1Doc.frontmatter,
        pending_sync: false,
        updated_at: new Date().toISOString()
      },
      body: step1Doc.body
    });
    await writeFile(taskPath, serializeTaskMDContent(step3Doc), "utf8");
  } catch (error) {
    await enqueueSyncRepair({
      taskId,
      reason: normalizeErrorReason(error),
      createdAt: new Date().toISOString()
    });

    await appendObservabilityLog({
      trace_id: options.traceId ?? "local",
      task_id: taskId,
      message_id: options.messageId ?? "local",
      from_status: previousStatus,
      to_status: nextStatus,
      latency_ms: Date.now() - startedAt,
      error_code: "E_DEP_UNAVAILABLE",
      event: "status_transition_sync_deferred",
      timestamp: new Date().toISOString(),
      details: { pending_sync: true }
    });
  }

  await appendObservabilityLog({
    trace_id: options.traceId ?? "local",
    task_id: taskId,
    message_id: options.messageId ?? "local",
    from_status: previousStatus,
    to_status: nextStatus,
    latency_ms: Date.now() - startedAt,
    error_code: options.errorCode ?? null,
    event: "status_transition",
    timestamp: new Date().toISOString()
  });

  return {
    previousStatus,
    nextStatus,
    version: nextVersion,
    updatedAt: nowIso
  };
}

export async function retrySyncRepairs(): Promise<SyncRepairJob[]> {
  const jobs = await readRepairQueue();
  if (jobs.length === 0) {
    return [];
  }

  const remaining: SyncRepairJob[] = [];
  for (const job of jobs) {
    try {
      const doc = await readTaskDocument(job.taskId);
      if (!doc.frontmatter.pending_sync) {
        continue;
      }

      await syncDerivedLayers(doc);
      const healed = parseTaskDocument({
        frontmatter: {
          ...doc.frontmatter,
          pending_sync: false,
          updated_at: new Date().toISOString()
        },
        body: doc.body
      });
      const taskPath = await resolveTaskPathByTaskId(job.taskId);
      await writeFile(taskPath, serializeTaskMDContent(healed), "utf8");
    } catch {
      remaining.push(job);
    }
  }

  await rewriteRepairQueue(remaining);
  return remaining;
}

/**
 * 查询幂等记录（用于握手重放/去重）。
 *
 * 行为：
 * - 计算入站 envelope 的幂等键
 * - 读取 JSONL 记录并按窗口裁剪（默认 7 天）
 * - 若命中同一 key，则直接返回之前落盘的 response（实现"至多一次"效果）
 *
 * 被使用位置：
 * - `src/task_agent/dispatcher.ts`：`dispatchInboundHandshake()` 首先尝试重放
 * - `tests/idempotency.spec.ts`：幂等逻辑测试
 */
export async function findIdempotencyRecord(envelope: HandshakeInboundEnvelope): Promise<IdempotencyRecord | null> {
  const all = await readIdempotencyRecords();
  const key = buildIdempotencyKey(envelope);
  const nowMs = Date.now();
  const kept = all.filter((record) => nowMs - Date.parse(record.createdAt) <= IDEMPOTENCY_WINDOW_MS);
  if (kept.length !== all.length) {
    await rewriteIdempotencyRecords(kept);
  }
  return kept.find((record) => record.key === key) ?? null;
}

/**
 * 写入幂等记录（用于握手去重）。
 *
 * 重要语义：
 * - 同一幂等键重复写入时：
 *   - 若 response 完全一致：视为幂等成功，直接返回
 *   - 若 response 不一致：抛 `E_IDEMPOTENCY_CONFLICT`，提示上层走错误响应
 *
 * 被使用位置：
 * - `src/task_agent/dispatcher.ts`：`dispatchInboundHandshake()` 结束时落盘
 * - `tests/idempotency.spec.ts`：幂等冲突/重放测试
 */
export async function saveIdempotencyRecord(
  envelope: HandshakeInboundEnvelope,
  response: HandshakeOutboundEnvelope
): Promise<void> {
  const all = await readIdempotencyRecords();
  const key = buildIdempotencyKey(envelope);
  const existing = all.find((record) => record.key === key);
  if (existing) {
    if (JSON.stringify(existing.response) !== JSON.stringify(response)) {
      throw new Error("E_IDEMPOTENCY_CONFLICT: existing response mismatches new response");
    }
    return;
  }

  const next: IdempotencyRecord = {
    key,
    taskId: envelope.task_id,
    createdAt: new Date().toISOString(),
    response
  };
  all.push(next);
  await rewriteIdempotencyRecords(all);
}

/**
 * 将入站/出站协议报文写入对应 task 的 `agent_chat/YYYY-MM-DD-agentchat.jsonl`。
 *
 * 被使用位置：
 * - `src/task_agent/dispatcher.ts`：记录握手 inbound/outbound，便于复盘与排障
 */
export async function appendAgentChatLog(taskId: string, entry: AgentChatLogEntry): Promise<void> {
  const taskPath = await resolveTaskPathByTaskId(taskId);
  const taskDir = path.dirname(taskPath);
  const agentChatDir = path.join(taskDir, "data", "agent_chat");
  await mkdir(agentChatDir, { recursive: true });
  const day = entry.timestamp.slice(0, 10);
  const filePath = path.join(agentChatDir, `${day}-agentchat.jsonl`);
  const existing = await safeReadText(filePath);
  const nextLine = JSON.stringify(entry);
  const next = existing.length === 0 ? `${nextLine}\n` : `${existing.trimEnd()}\n${nextLine}\n`;
  await writeFile(filePath, next, "utf8");
}

/**
 * 读取最近一次握手收发快照（用于 Waiting_Human 阶段向用户展示"本次握手发生了什么"）。
 *
 * 读取来源：
 * - `task_dir/data/agent_chat/YYYY-MM-DD-agentchat.jsonl`（由 `appendAgentChatLog()` 写入）
 *
 * 注意：
 * - 这是"尽力而为"的读取：若文件缺失/解析失败，则返回 null 字段，不抛错。
 * - 当前只读取"最后一个" agentchat 文件，并从末尾向前寻找最近的 inbound/outbound 报文。
 */
export async function readLatestHandshakeExchange(taskId: string): Promise<HandshakeExchangeSnapshot> {
  const taskPath = await resolveTaskPathByTaskId(taskId);
  const taskDir = path.dirname(taskPath);
  const agentChatDir = path.join(taskDir, "data", "agent_chat");
  const entries = await safeReadDir(agentChatDir);

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith("-agentchat.jsonl"))
    .map((entry) => entry.name)
    .sort();

  if (files.length === 0) {
    return { inbound: null, outbound: null, sourceFilePath: null };
  }

  const latestFile = files[files.length - 1];
  const filePath = path.join(agentChatDir, latestFile);
  const raw = await safeReadText(filePath);
  if (raw.trim().length === 0) {
    return { inbound: null, outbound: null, sourceFilePath: filePath };
  }

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let inbound: HandshakeInboundEnvelope | null = null;
  let outbound: HandshakeOutboundEnvelope | null = null;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(line);
    } catch {
      continue;
    }

    if (!isAgentChatLogEntry(parsedLine)) {
      continue;
    }

    if (parsedLine.direction === "outbound" && outbound === null) {
      try {
        outbound = parseHandshakeOutboundEnvelope(parsedLine.payload);
      } catch {
        // ignore
      }
    }

    if (parsedLine.direction === "inbound" && inbound === null) {
      try {
        inbound = parseHandshakeInboundEnvelope(parsedLine.payload);
      } catch {
        // ignore
      }
    }

    if (inbound && outbound) {
      break;
    }
  }

  return { inbound, outbound, sourceFilePath: filePath };
}

/**
 * 写入本地 scratchpad（只用于本机研判）。
 * 重要：该文件严禁通过网络发送，避免泄露内部推理/草稿内容。
 *
 * 被使用位置：
 * - `src/task_agent/dispatcher.ts`：`executeL2Sandbox()` 的研判结果落盘（仅本地）
 */
export async function appendScratchpadNote(taskId: string, note: string, timestamp: string): Promise<void> {
  const taskPath = await resolveTaskPathByTaskId(taskId);
  const taskDir = path.dirname(taskPath);
  const scratchpadPath = path.join(taskDir, "data", "agent_chat", "scratchpad.md");
  const existing = await safeReadText(scratchpadPath);
  const block = `\n## ${timestamp}\n${note}\n`;
  const next = existing.length === 0 ? `# scratchpad\n${block}` : `${existing.trimEnd()}\n${block}`;
  await writeFile(scratchpadPath, next, "utf8");
}

/**
 * 读取 `.data/User.md`（用于 L2 本地研判的用户画像/偏好）。
 *
 * 被使用位置：
 * - `src/task_agent/dispatcher.ts`：`executeL2Sandbox()` 决策时取用户偏好
 */
export async function readUserProfile(): Promise<string> {
  return safeReadText(USER_PROFILE_FILE);
}

/**
 * 将对话原文快照归档到 `raw_chats/`（默认保留 90 天）。
 *
 * 被使用位置：
 * - `src/task_agent/task_loop.ts`：intake 对话归档
 * - `src/task_agent/memory.ts`：memory flush 时归档 raw snapshot
 */
export async function appendRawChat(taskId: string, content: string, timestamp: string): Promise<string> {
  const taskPath = await resolveTaskPathByTaskId(taskId);
  const taskDir = path.dirname(taskPath);
  const rawChatDir = path.join(taskDir, "data", "raw_chats");
  await mkdir(rawChatDir, { recursive: true });
  const day = timestamp.slice(0, 10);
  const filePath = path.join(rawChatDir, `${day}-chat.md`);
  await writeFile(filePath, content, "utf8");
  return filePath;
}

/**
 * 将对话总结写入 `.data/raw_chats_summary/`（按天覆盖写，适合做日报/摘要）。
 *
 * 被使用位置：
 * - `src/task_agent/task_loop.ts`：intake summary
 * - `src/task_agent/memory.ts`：memory flush summary
 */
export async function appendRawChatSummary(content: string, timestamp: string): Promise<string> {
  await mkdir(GLOBAL_RAW_CHAT_SUMMARY_DIR, { recursive: true });
  const day = timestamp.slice(0, 10);
  const filePath = path.join(GLOBAL_RAW_CHAT_SUMMARY_DIR, `${day}-summary.md`);
  await writeFile(filePath, content, "utf8");
  return filePath;
}

/**
 * 将结构化系统事件以 JSON 行写入 `.data/logs/YYYY-MM-DD-sys.md`。
 *
 * 被使用位置：
 * - `transitionTaskStatus()`：状态迁移审计
 * - `cleanupExpiredData()` / `rebuildIndex()` / `resumeFailedOrTimeoutTask()`：维护路径审计
 * - `src/task_agent/memory.ts`：memory flush 指标记录
 */
export async function appendObservabilityLog(event: ObservabilityLogEvent): Promise<void> {
  await mkdir(GLOBAL_LOG_DIR, { recursive: true });
  const day = event.timestamp.slice(0, 10);
  const filePath = path.join(GLOBAL_LOG_DIR, `${day}-sys.md`);
  const existing = await safeReadText(filePath);
  const line = JSON.stringify(event);
  const next = existing.length === 0 ? `${line}\n` : `${existing.trimEnd()}\n${line}\n`;
  await writeFile(filePath, next, "utf8");
}

/**
 * 保留策略清理任务：
 * - `raw_chats/*-chat.md`：默认保留 90 天
 * - `agent_chat/*-agentchat.jsonl`：默认保留 180 天
 * 清理后会写一条审计日志到 `.data/logs/`。
 *
 * 注意：
 * - 这里通过文件名中的日期前缀判断"文件年龄"，不依赖文件系统 mtime（更稳定/可搬迁）。
 */
export async function cleanupExpiredData(nowIso = new Date().toISOString()): Promise<RetentionCleanupResult> {
  const nowMs = Date.parse(nowIso);
  const rawCutoffMs = nowMs - RAW_CHATS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const agentCutoffMs = nowMs - AGENT_CHAT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  let deletedRawChats = 0;
  let deletedAgentChatJsonl = 0;
  const records = await listAllTaskRecords();
  const seenDirs = new Set<string>();

  for (const record of records) {
    const taskDir = path.dirname(record.taskPath);
    if (seenDirs.has(taskDir)) {
      continue;
    }
    seenDirs.add(taskDir);

    const rawDir = path.join(taskDir, "data", "raw_chats");
    const agentDir = path.join(taskDir, "data", "agent_chat");

    deletedRawChats += await cleanupFilesByAge(rawDir, /-chat\\.md$/, rawCutoffMs);
    deletedAgentChatJsonl += await cleanupFilesByAge(agentDir, /-agentchat\\.jsonl$/, agentCutoffMs);
  }

  await appendObservabilityLog({
    trace_id: "maintenance",
    task_id: "N/A",
    message_id: "retention",
    from_status: "N/A",
    to_status: "N/A",
    latency_ms: 0,
    error_code: null,
    event: "retention_cleanup",
    timestamp: nowIso,
    details: {
      deleted_raw_chats: deletedRawChats,
      deleted_agent_chat_jsonl: deletedAgentChatJsonl
    }
  });

  return { deletedRawChats, deletedAgentChatJsonl };
}

/**
 * 全量重建派生索引（幂等）。
 * 当前实现：为每个 task 写入 `embedding_data/task_embedding_index.json` 的占位索引 ID。
 *
 * 应用场景：
 * - 索引损坏、全量重建、冷启动恢复
 */
export async function rebuildIndex(): Promise<number> {
  const records = await listAllTaskRecords();
  const uniqueTaskIds = new Set<string>();

  for (const record of records) {
    const task = record.task;
    uniqueTaskIds.add(task.frontmatter.task_id);
    const taskPath = record.taskPath;
    const taskDir = path.dirname(taskPath);
    const embeddingDir = path.join(taskDir, "data", "embedding_data");
    await mkdir(embeddingDir, { recursive: true });
    const indexPath = path.join(embeddingDir, "task_embedding_index.json");
    const payload = {
      version: 1,
      indices: [`idx_${task.frontmatter.task_id}`]
    };
    await writeFile(indexPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  await appendObservabilityLog({
    trace_id: "maintenance",
    task_id: "N/A",
    message_id: "rebuild_index",
    from_status: "N/A",
    to_status: "N/A",
    latency_ms: 0,
    error_code: null,
    event: "rebuild_index",
    timestamp: new Date().toISOString(),
    details: { task_count: uniqueTaskIds.size }
  });

  return uniqueTaskIds.size;
}

/**
 * `Timeout|Failed -> Searching` 的显式恢复入口。
 *
 * 语义：
 * - 强制要求当前状态必须是 Timeout/Failed
 * - 使用乐观锁避免覆盖并发更新
 * - 记录触发人（triggerBy）到审计日志，便于追责/排障
 */
export async function resumeFailedOrTimeoutTask(taskId: string, triggerBy: string): Promise<TransitionResult> {
  const current = await readTaskDocument(taskId);
  if (current.frontmatter.status !== "Timeout" && current.frontmatter.status !== "Failed") {
    throw new Error(`E_INVALID_TRANSITION: ${current.frontmatter.status} cannot resume to Searching`);
  }

  const result = await transitionTaskStatus(taskId, "Searching", {
    expectedVersion: current.frontmatter.version,
    traceId: "resume",
    messageId: triggerBy
  });

  await appendObservabilityLog({
    trace_id: "resume",
    task_id: taskId,
    message_id: triggerBy,
    from_status: current.frontmatter.status,
    to_status: "Searching",
    latency_ms: 0,
    error_code: null,
    event: "manual_resume",
    timestamp: new Date().toISOString(),
    details: { trigger_by: triggerBy }
  });

  return result;
}

/** 校验状态迁移是否合法（不合法直接抛 `E_INVALID_TRANSITION`）。 */
function assertTransitionAllowed(current: TaskStatus, next: TaskStatus): void {
  const allowed = ALLOWED_STATUS_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    throw new Error(`E_INVALID_TRANSITION: ${current} -> ${next} is not allowed`);
  }
}

/**
 * 通过扫描 `.data/task_agents/<task_dir>/task.md` 定位某个 `task_id` 对应的文件路径。
 * - `createIfMissing=true`：用于首次创建任务时生成一个目录并返回其 `task.md` 路径。
 *
 * 性能说明：
 * - 当前实现是"全量扫描"，适合任务量不大/本地原型阶段；
 * - 若任务量增大，建议引入索引或稳定映射（例如 task_id -> folder 的 KV）。
 */
async function resolveTaskPathByTaskId(taskId: string, createIfMissing = false): Promise<string> {
  const entries = await readdir(TASK_AGENTS_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const maybeTaskPath = path.join(TASK_AGENTS_ROOT, entry.name, "task.md");
    const content = await safeReadText(maybeTaskPath);
    if (content.length === 0) {
      continue;
    }
    const doc = parseTaskMDContent(content);
    if (doc.frontmatter.task_id === taskId) {
      return maybeTaskPath;
    }
  }
  if (createIfMissing) {
    const taskFolder = path.join(TASK_AGENTS_ROOT, toTaskFolderName(taskId));
    await mkdir(taskFolder, { recursive: true });
    return path.join(taskFolder, "task.md");
  }
  throw new Error(`E_TASK_NOT_FOUND: ${taskId}`);
}

/** 读取并解析指定路径的 `task.md`。 */
async function readTaskDocumentByPath(taskPath: string): Promise<TaskDocument> {
  const content = await readFile(taskPath, "utf8");
  return parseTaskMDContent(content);
}

/**
 * 解析 `task.md` 为结构化 `TaskDocument`。
 *
 * 解析规则：
 * - YAML frontmatter：按项目约束的最小 YAML 子集解析（不是通用 YAML 解析器）
 * - markdown body：必须包含 `### 原始描述`、`### 靶向映射`、`Target_Activity/Target_Vibe`
 *
 * 被使用位置：
 * - `saveTaskMD()`：写入前校验 / 做乐观锁校验时解析现有版本
 * - `readTaskDocumentByPath()` / `listAllTaskRecords()`：读取/扫描任务
 */
export function parseTaskMDContent(content: string): TaskDocument {
  // 约束：必须以 `---` 开始/结束 frontmatter；正文可为空但最终会被模板解析校验。
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!frontmatterMatch) {
    throw new Error("E_TASK_MD_INVALID: missing YAML frontmatter");
  }

  const yamlText = frontmatterMatch[1];
  const bodyText = frontmatterMatch[2].trim();
  const frontmatter = parseSimpleYamlObject(yamlText);
  const body = parseTaskBody(bodyText);

  return parseTaskDocument({ frontmatter, body });
}

/**
 * 将 `TaskDocument` 按稳定格式序列化为 `task.md` 文本（便于 diff/审计/回放）。
 *
 * 被使用位置：
 * - `saveTaskMD()` / `transitionTaskStatus()` / `retrySyncRepairs()`：写回真相源文件
 */
export function serializeTaskMDContent(task: TaskDocument): string {
  const frontmatterYaml = serializeSimpleYamlObject(task.frontmatter);
  const detailedSection = task.body.detailedPlan
    ? `\n\n### 需求详情\n${task.body.detailedPlan}`
    : "\n\n### 需求详情\n（待 AI 生成）";
  return `---\n${frontmatterYaml}\n---\n\n### 原始描述\n${task.body.rawDescription}\n\n### 靶向映射\n<Target_Activity>${task.body.targetActivity}</Target_Activity>\n<Target_Vibe>${task.body.targetVibe}</Target_Vibe>${detailedSection}\n`;
}

/**
 * 解析任务正文的固定模板段落。
 * 缺失字段则抛错，防止脏数据扩散到后续状态机/检索管线。
 */
function parseTaskBody(bodyText: string): { rawDescription: string; targetActivity: string; targetVibe: string; detailedPlan: string } {
  const rawSection = bodyText.match(/### 原始描述\s*([\s\S]*?)\n### 靶向映射/);
  const activityMatch = bodyText.match(/<Target_Activity>([\s\S]*?)<\/Target_Activity>/);
  const vibeMatch = bodyText.match(/<Target_Vibe>([\s\S]*?)<\/Target_Vibe>/);

  if (!rawSection || !activityMatch || !vibeMatch) {
    throw new Error("E_TASK_BODY_INVALID: required sections are missing");
  }

  const rawDescription = rawSection[1].trim();
  const targetActivity = activityMatch[1].trim();
  const targetVibe = vibeMatch[1].trim();

  // Parse optional detailed plan section
  const detailedMatch = bodyText.match(/### 需求详情\s*([\s\S]*)$/);
  const detailedPlan = detailedMatch ? detailedMatch[1].trim() : "";
  // Filter out placeholder text
  const cleanPlan = detailedPlan === "（待 AI 生成）" ? "" : detailedPlan;

  return { rawDescription, targetActivity, targetVibe, detailedPlan: cleanPlan };
}

/**
 * 解析 frontmatter 的极简 YAML（只支持 `key: value`、内联数组、布尔、数字、null、字符串）。
 * 注意：这不是通用 YAML 解析器，仅覆盖本项目 `task.md` 的约束格式。
 */
function parseSimpleYamlObject(yamlText: string): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  const lines = yamlText.split("\n").map((line) => line.trim());
  for (const line of lines) {
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      throw new Error(`E_YAML_PARSE: invalid line "${line}"`);
    }
    const key = line.slice(0, separatorIndex).trim();
    const valueText = line.slice(separatorIndex + 1).trim();
    raw[key] = parseYamlScalarOrArray(valueText);
  }

  return raw;
}

/** 解析 YAML 标量/数组的最小集合。 */
function parseYamlScalarOrArray(valueText: string): unknown {
  if (valueText === "null") {
    return null;
  }
  if (valueText === "true") {
    return true;
  }
  if (valueText === "false") {
    return false;
  }
  if (valueText.startsWith("[") && valueText.endsWith("]")) {
    const inner = valueText.slice(1, -1).trim();
    if (inner.length === 0) {
      return [];
    }
    return inner.split(",").map((part) => stripYamlQuotes(part.trim()));
  }
  if (/^-?\d+$/.test(valueText)) {
    return Number(valueText);
  }
  return stripYamlQuotes(valueText);
}

function stripYamlQuotes(valueText: string): string {
  // 该实现只处理整体包裹的最外层引号，不做 YAML 级别的复杂转义（已足够覆盖本项目输入约束）。
  if ((valueText.startsWith("\"") && valueText.endsWith("\"")) || (valueText.startsWith("'") && valueText.endsWith("'"))) {
    return valueText.slice(1, -1);
  }
  return valueText;
}

/** 将 frontmatter 按固定字段顺序写回 YAML，避免无意义 diff。 */
function serializeSimpleYamlObject(frontmatter: TaskFrontmatter): string {
  return [
    `task_id: ${quoteYaml(frontmatter.task_id)}`,
    `status: ${quoteYaml(frontmatter.status)}`,
    `interaction_type: ${quoteYaml(frontmatter.interaction_type)}`,
    `current_partner_id: ${frontmatter.current_partner_id === null ? "null" : quoteYaml(frontmatter.current_partner_id)}`,
    `entered_status_at: ${quoteYaml(frontmatter.entered_status_at)}`,
    `created_at: ${quoteYaml(frontmatter.created_at)}`,
    `updated_at: ${quoteYaml(frontmatter.updated_at)}`,
    `version: ${frontmatter.version}`,
    `pending_sync: ${frontmatter.pending_sync ? "true" : "false"}`,
    `hidden: ${frontmatter.hidden ? "true" : "false"}`
  ].join("\n");
}

/** YAML 字符串转义与引用（仅处理双引号转义）。 */
function quoteYaml(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** 将 task_id 映射为稳定的目录名（用于 `createIfMissing` 场景）。 */
function toTaskFolderName(taskId: string): string {
  const normalized = taskId.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return `task_${normalized}`;
}

/**
 * 扫描本机所有任务并尝试解析；解析失败的任务文件会被忽略。
 * 目的：避免一处脏 `task.md` 拖垮全局轮询/匹配流程。
 */
async function listAllTaskRecords(): Promise<TaskRecord[]> {
  const entries = await readdir(TASK_AGENTS_ROOT, { withFileTypes: true });
  const result: TaskRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const taskPath = path.join(TASK_AGENTS_ROOT, entry.name, "task.md");
    const content = await safeReadText(taskPath);
    if (content.length === 0) {
      continue;
    }

    try {
      const task = parseTaskMDContent(content);
      result.push({ taskPath, task });
    } catch {
      // 扫描时跳过格式错误的 task.md，避免一处脏文件拖垮全局轮询。
    }
  }

  return result;
}

/** 按文件名中的日期前缀清理过期文件（删除动作本身是幂等的）。 */
async function cleanupFilesByAge(dirPath: string, namePattern: RegExp, cutoffMs: number): Promise<number> {
  const entries = await safeReadDir(dirPath);
  let deleted = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !namePattern.test(entry.name)) {
      continue;
    }
    const date = extractDateFromFilename(entry.name);
    if (!date) {
      continue;
    }
    const fileMs = Date.parse(`${date}T00:00:00.000Z`);
    if (Number.isNaN(fileMs)) {
      continue;
    }
    if (fileMs < cutoffMs) {
      await unlink(path.join(dirPath, entry.name));
      deleted += 1;
    }
  }
  return deleted;
}

/** 安全读取目录：不存在/无权限时返回空。 */
async function safeReadDir(dirPath: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 从文件名提取 `YYYY-MM-DD` 前缀，用于保留策略的粗粒度判断。 */
function extractDateFromFilename(name: string): string | null {
  const match = name.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

/** 安全读取文本文件：不存在/无权限时返回空字符串。 */
async function safeReadText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    // 刻意吞掉错误：这些文件多为"派生/可选数据"，缺失不应中断主流程。
    return "";
  }
}

/** 读取修复队列（JSONL）。 */
async function readRepairQueue(): Promise<SyncRepairJob[]> {
  const raw = await safeReadText(SYNC_REPAIR_QUEUE_FILE);
  if (raw.trim().length === 0) {
    return [];
  }
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const jobs: SyncRepairJob[] = [];
  for (const line of lines) {
    const parsed: unknown = JSON.parse(line);
    if (!isSyncRepairJob(parsed)) {
      continue;
    }
    jobs.push(parsed);
  }
  return jobs;
}

/** 读取幂等记录（JSONL）。 */
async function readIdempotencyRecords(): Promise<IdempotencyRecord[]> {
  const raw = await safeReadText(IDEMPOTENCY_FILE);
  if (raw.trim().length === 0) {
    return [];
  }
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const result: IdempotencyRecord[] = [];
  for (const line of lines) {
    const parsed: unknown = JSON.parse(line);
    if (!isIdempotencyRecord(parsed)) {
      continue;
    }
    result.push(parsed);
  }
  return result;
}

/** 重写修复队列（用于重试后写回剩余 job）。 */
async function rewriteRepairQueue(jobs: SyncRepairJob[]): Promise<void> {
  if (jobs.length === 0) {
    await writeFile(SYNC_REPAIR_QUEUE_FILE, "", "utf8");
    return;
  }
  const next = `${jobs.map((job) => JSON.stringify(job)).join("\n")}\n`;
  await writeFile(SYNC_REPAIR_QUEUE_FILE, next, "utf8");
}

/** 重写幂等记录（用于窗口裁剪/去重归一）。 */
async function rewriteIdempotencyRecords(records: IdempotencyRecord[]): Promise<void> {
  if (records.length === 0) {
    await writeFile(IDEMPOTENCY_FILE, "", "utf8");
    return;
  }
  const next = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  await writeFile(IDEMPOTENCY_FILE, next, "utf8");
}

/** 修复队列行的运行时类型守卫（防止 JSONL 脏行导致崩溃）。 */
function isSyncRepairJob(input: unknown): input is SyncRepairJob {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const maybe = input as Record<string, unknown>;
  return (
    typeof maybe.taskId === "string" &&
    maybe.taskId.length > 0 &&
    typeof maybe.reason === "string" &&
    maybe.reason.length > 0 &&
    typeof maybe.createdAt === "string" &&
    maybe.createdAt.length > 0
  );
}

/** 幂等记录行的运行时类型守卫。 */
function isIdempotencyRecord(input: unknown): input is IdempotencyRecord {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const maybe = input as Record<string, unknown>;
  return (
    typeof maybe.key === "string" &&
    maybe.key.length > 0 &&
    typeof maybe.taskId === "string" &&
    maybe.taskId.length > 0 &&
    typeof maybe.createdAt === "string" &&
    maybe.createdAt.length > 0 &&
    typeof maybe.response === "object" &&
    maybe.response !== null
  );
}

/** agent_chat JSONL 行的运行时类型守卫。 */
function isAgentChatLogEntry(input: unknown): input is AgentChatLogEntry {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const maybe = input as Record<string, unknown>;
  return (
    (maybe.direction === "inbound" || maybe.direction === "outbound") &&
    typeof maybe.timestamp === "string" &&
    maybe.timestamp.length > 0 &&
    "payload" in maybe
  );
}

/** 构建幂等键：`message_id::sender_agent_id::protocol_version`。 */
function buildIdempotencyKey(envelope: HandshakeInboundEnvelope): string {
  return `${envelope.message_id}::${envelope.sender_agent_id}::${envelope.protocol_version}`;
}

/** 将异常归一化为可落盘的错误原因（用于修复队列与审计）。 */
function normalizeErrorReason(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "E_DEP_UNAVAILABLE";
}

async function syncDerivedLayers(_task: TaskDocument): Promise<void> {
  const taskPath = await resolveTaskPathByTaskId(_task.frontmatter.task_id);
  upsertTaskSnapshot(_task, taskPath);
}

// ---------------------------------------------------------------------------
// Negotiation Session Storage
// ---------------------------------------------------------------------------

/**
 * Create or update a negotiation session for a Listening task.
 * Sessions are stored in `task_dir/data/sessions.jsonl`.
 */
export async function upsertNegotiationSession(session: NegotiationSession): Promise<void> {
  const sessions = await readAllSessions(session.task_id);
  const index = sessions.findIndex((s) => s.session_id === session.session_id);
  if (index >= 0) {
    sessions[index] = session;
  } else {
    sessions.push(session);
  }
  await rewriteSessions(session.task_id, sessions);
}

/**
 * Find an existing session by remote_agent_id (for multi-round negotiation with the same agent).
 */
export async function findSessionByRemoteAgent(taskId: string, remoteAgentId: string): Promise<NegotiationSession | null> {
  const sessions = await readAllSessions(taskId);
  return sessions.find((s) => s.remote_agent_id === remoteAgentId && s.status !== "Rejected" && s.status !== "Timeout") ?? null;
}

/**
 * List all negotiation sessions for a task.
 */
export async function listNegotiationSessions(taskId: string): Promise<NegotiationSession[]> {
  return readAllSessions(taskId);
}

/**
 * Generate a ListeningReport from all sessions accumulated during Listening.
 */
export async function generateListeningReport(taskId: string): Promise<ListeningReport> {
  const sessions = await readAllSessions(taskId);
  const accepted = sessions.filter((s) => s.status === "Accepted").length;
  const rejected = sessions.filter((s) => s.status === "Rejected").length;
  const timedOut = sessions.filter((s) => s.status === "Timeout").length;

  // Sort by match_score descending (accepted first, then by score)
  const sorted = [...sessions].sort((a, b) => {
    const statusOrder: Record<SessionStatus, number> = { Accepted: 0, Negotiating: 1, Rejected: 2, Timeout: 3 };
    const aDiff = statusOrder[a.status] - statusOrder[b.status];
    if (aDiff !== 0) return aDiff;
    return (b.match_score ?? -1) - (a.match_score ?? -1);
  });

  return {
    task_id: taskId,
    total_handshakes: sessions.length,
    accepted,
    rejected,
    timed_out: timedOut,
    sessions: sorted,
    generated_at: new Date().toISOString()
  };
}

/**
 * Mark timed-out sessions. Returns the number of sessions that were timed out.
 */
export async function expireTimedOutSessions(taskId: string): Promise<number> {
  const sessions = await readAllSessions(taskId);
  const now = Date.now();
  let expired = 0;
  for (const session of sessions) {
    if (session.status === "Negotiating") {
      if (now > Date.parse(session.timeout_at)) {
        session.status = "Timeout";
        session.updated_at = new Date().toISOString();
        expired += 1;
      }
    }
  }
  if (expired > 0) {
    await rewriteSessions(taskId, sessions);
  }
  return expired;
}

async function readAllSessions(taskId: string): Promise<NegotiationSession[]> {
  const taskPath = await resolveTaskPathByTaskId(taskId);
  const taskDir = path.dirname(taskPath);
  const sessionsFile = path.join(taskDir, "data", "sessions.jsonl");
  const raw = await safeReadText(sessionsFile);
  if (raw.trim().length === 0) {
    return [];
  }
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const result: NegotiationSession[] = [];
  for (const line of lines) {
    try {
      const parsed = NegotiationSessionSchema.parse(JSON.parse(line));
      result.push(parsed);
    } catch {
      // Skip malformed session lines
    }
  }
  return result;
}

async function rewriteSessions(taskId: string, sessions: NegotiationSession[]): Promise<void> {
  const taskPath = await resolveTaskPathByTaskId(taskId);
  const taskDir = path.dirname(taskPath);
  const sessionsDir = path.join(taskDir, "data");
  await mkdir(sessionsDir, { recursive: true });
  const sessionsFile = path.join(sessionsDir, "sessions.jsonl");
  if (sessions.length === 0) {
    await writeFile(sessionsFile, "", "utf8");
    return;
  }
  const content = sessions.map((s) => JSON.stringify(s)).join("\n") + "\n";
  await writeFile(sessionsFile, content, "utf8");
}
