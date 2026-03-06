import { randomUUID } from "node:crypto";
import { stdin as input, stdout as output } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import { retrieveBySemanticSimilarity } from "../rag/retrieval";
import {
  appendAgentChatLog,
  appendScratchpadNote,
  expireTimedOutSessions,
  findIdempotencyRecord,
  findSessionByRemoteAgent,
  generateListeningReport,
  listTasksByStatuses,
  queryL0Candidates,
  readLatestHandshakeExchange,
  readTaskDocument,
  readUserProfile,
  saveIdempotencyRecord,
  transitionTaskStatus,
  upsertNegotiationSession
} from "./util/storage";
import type {
  ErrorCode,
  HandshakeInboundEnvelope,
  HandshakeOutboundEnvelope,
  L0Candidate,
  L1Candidate,
  ListeningReport,
  NegotiationSession,
  TaskDocument,
  TaskStatus
} from "./util/schema";
import { start_chat, send_friend_request } from "./friend";

/**
 * 任务匹配调度器（Matching Dispatcher）。
 *
 * 职责：
 * - 主动流（active flow）：驱动本地任务的状态机推进（Drafting/Revising -> Searching(L0+L1) -> Negotiating(L2)）
 * - 被动流（passive flow）：Listening 状态下接收对端 L2 握手，通过 session 自治处理，task 不迁移
 * - 匹配漏斗：L0（结构化硬过滤）+ L1（语义检索）在 Searching 阶段执行；L2（双边协商）在 Negotiating/Listening 阶段执行
 *
 * I/O 边界：
 * - 本模块不直接做文件系统 I/O；所有落盘都通过 `src/task_agent/util/storage.ts`（防腐层）完成。
 *
 * 被使用位置：
 * - `src/task_agent/task_loop.ts`：周期性调用 `processDraftingTasks()` / `processSearchingTasks()`
 */

/** L2 研判结果：用于决定如何响应对端以及是否触发本地状态变更。 */
interface L2Decision {
  /** 本端希望给对端的最终动作（本阶段仅实现 ACCEPT/REJECT）。 */
  action: "ACCEPT" | "REJECT";
  /** 是否建议把本地任务标记为 Revising（提示 owner 更新/介入）。 */
  shouldMoveToRevising: boolean;
  /** 仅本地落盘的研判笔记（写入 scratchpad，严禁外发）。 */
  scratchpadNote: string;
}

export type WaitingHumanIntent = "satisfied" | "unsatisfied" | "enable_listener" | "closed" | "friend_request" | "exit";

export interface WaitingHumanSummary {
  taskId: string;
  status: TaskStatus;
  targetActivity: string;
  targetVibe: string;
  snapshot: Awaited<ReturnType<typeof readLatestHandshakeExchange>>;
}

export interface WaitingHumanIntentResult {
  taskId: string;
  intent: WaitingHumanIntent;
  statusChanged: boolean;
  nextStatus: TaskStatus | null;
  message: string;
}

/**
 * 处理 Drafting/Revising 任务：推进到 Searching。
 *
 * 语义：
 * - Drafting：刚 intake 进来，还没进入匹配池
 * - Revising：等待 owner 修改后再尝试匹配
 */
export async function processDraftingTasks(): Promise<number> {
  const draftLikeTasks = await listTasksByStatuses(["Drafting", "Revising"]);
  let changed = 0;
  for (const task of draftLikeTasks) {
    if (await processDraftingTask(task)) {
      changed += 1;
    }
  }
  return changed;
}

export async function processDraftingTask(task: TaskDocument): Promise<boolean> {
  if (task.frontmatter.status !== "Drafting" && task.frontmatter.status !== "Revising") {
    return false;
  }
  await transitionTaskStatus(task.frontmatter.task_id, "Searching", {
    expectedVersion: task.frontmatter.version
  });
  return true;
}

/**
 * 处理 Searching 任务：执行 L1 检索并对最优候选发送 propose（当前为占位实现），随后推进到 Negotiating。
 *
 * 注意：
 * - `sendInitialPropose()` 目前返回 true（占位）；未来应在此接入网络/消息总线发送 PROPOSE。
 * - 任何状态推进都应通过 `transitionTaskStatus()`，以获得乐观锁/审计日志/派生层同步语义。
 */
export async function processSearchingTasks(): Promise<number> {
  const searchingTasks = await listTasksByStatuses(["Searching"]);
  let changed = 0;
  for (const task of searchingTasks) {
    if (await processSearchingTask(task)) {
      changed += 1;
    }
  }
  return changed;
}

export async function processSearchingTask(task: TaskDocument): Promise<boolean> {
  if (task.frontmatter.status !== "Searching") {
    return false;
  }

  const l1 = await runL1Retrieval(task);
  if (l1.length === 0) {
    return false;
  }

  const topCandidate = l1[0];
  const proposeSent = await sendInitialPropose(task.frontmatter.task_id, topCandidate.taskId);
  if (!proposeSent) {
    return false;
  }

  await transitionTaskStatus(task.frontmatter.task_id, "Negotiating", {
    expectedVersion: task.frontmatter.version
  });
  return true;
}

/**
 * 处理 Waiting_Human 任务：向用户展示“最近一次握手（L2 决策）的摘要”，并询问是否满意。
 *
 * 业务目的：
 * - Waiting_Human 表示“机器已经完成协商/匹配到某个阶段，需要人类确认/介入”
 * - 这里把握手收发日志（inbound/outbound）整理成可读摘要，给 owner 做 yes/no 决策
 *
 * 用户选择：
 * - 满意（yes/y）：进入下一阶段 `start_chat(taskId)`（当前占位，不实现具体聊天内容）
 * - 不满意（no/n）：把任务状态退回 Drafting，让用户修改 task.md 后再走匹配流程
 *
 * 注意：
 * - 该处理依赖 TTY（交互式终端）。非 TTY 环境直接跳过，避免服务/CI 卡死等待输入。
 * - 状态回退使用 `transitionTaskStatus()`（会自动 bump version/updated_at 等），无需额外“读改写”函数。
 */
export async function processWaitingHumanTasks(rl?: Interface): Promise<void> {
  if (!rl && !input.isTTY) {
    return;
  }

  const tasks = await listTasksByStatuses(["Waiting_Human"]);
  if (tasks.length === 0) {
    return;
  }

  const localRl = rl ?? createInterface({ input, output });
  const shouldClose = rl === undefined;
  try {
    for (const task of tasks) {
      const snapshot = await readLatestHandshakeExchange(task.frontmatter.task_id);
      const summary = formatHandshakeSummary(task, snapshot);

      output.write(`\n===== Waiting_Human: 需要你确认握手结果 =====\n`);
      output.write(`${summary}\n`);

      const answer = (await localRl.question("是否满意本次握手结果？输入 yes 进入聊天；输入 no 退回 Drafting："))
        .trim()
        .toLowerCase();
      if (answer === "yes" || answer === "y") {
        await start_chat(task.frontmatter.task_id);
        continue;
      }

      if (answer === "no" || answer === "n") {
        try {
          await transitionTaskStatus(task.frontmatter.task_id, "Drafting", {
            expectedVersion: task.frontmatter.version,
            traceId: "waiting_human",
            messageId: "owner"
          });
        } catch (error) {
          output.write(`状态回退失败（可能是并发更新导致版本冲突）：${normalizeErrorMessage(error)}\n`);
        }
        continue;
      }

      output.write("输入无效，跳过该任务（保持 Waiting_Human）。\n");
    }
  } finally {
    if (shouldClose) {
      localRl.close();
    }
  }
}

export async function processWaitingHumanTask(task: TaskDocument, rl?: Interface): Promise<boolean> {
  if (task.frontmatter.status !== "Waiting_Human") {
    return false;
  }
  if (!rl && !input.isTTY) {
    return false;
  }

  const localRl = rl ?? createInterface({ input, output });
  const shouldClose = rl === undefined;
  try {
    const summary = await getWaitingHumanSummary(task.frontmatter.task_id);
    const summaryText = formatHandshakeSummary(task, summary.snapshot);

    output.write(`\n===== Waiting_Human: 需要你确认握手结果 =====\n`);
    output.write(`${summaryText}\n`);

    const answer = (await localRl.question("是否满意本次握手结果？输入 yes 进入聊天；输入 no 退回 Drafting："))
      .trim()
      .toLowerCase();
    if (answer === "yes" || answer === "y") {
      const result = await handleWaitingHumanIntent(task.frontmatter.task_id, "satisfied");
      return result.statusChanged || result.intent === "satisfied";
    }

    if (answer === "no" || answer === "n") {
      try {
        const result = await handleWaitingHumanIntent(task.frontmatter.task_id, "unsatisfied");
        return result.statusChanged;
      } catch (error) {
        output.write(`状态回退失败（可能是并发更新导致版本冲突）：${normalizeErrorMessage(error)}\n`);
        return false;
      }
    }

    output.write("输入无效，跳过该任务（保持 Waiting_Human）。\n");
    return false;
  } finally {
    if (shouldClose) {
      localRl.close();
    }
  }
}

export async function getWaitingHumanSummary(taskId: string): Promise<WaitingHumanSummary> {
  const task = await readTaskDocument(taskId);
  const snapshot = await readLatestHandshakeExchange(taskId);
  return {
    taskId,
    status: task.frontmatter.status,
    targetActivity: task.body.targetActivity,
    targetVibe: task.body.targetVibe,
    snapshot
  };
}

/**
 * Generate a listening report for a task (expire timed-out sessions first).
 * Used when user does `unlisten` to see what happened during Listening.
 */
export async function getListeningReportForTask(taskId: string): Promise<ListeningReport> {
  await expireTimedOutSessions(taskId);
  return generateListeningReport(taskId);
}

export async function handleWaitingHumanIntent(taskId: string, intent: WaitingHumanIntent): Promise<WaitingHumanIntentResult> {
  const task = await readTaskDocument(taskId);
  if (task.frontmatter.status !== "Waiting_Human") {
    return {
      taskId,
      intent,
      statusChanged: false,
      nextStatus: task.frontmatter.status,
      message: `Task is not Waiting_Human: ${task.frontmatter.status}`
    };
  }

  if (intent === "satisfied") {
    await start_chat(taskId);
    return {
      taskId,
      intent,
      statusChanged: false,
      nextStatus: task.frontmatter.status,
      message: "Accepted by human; start_chat invoked."
    };
  }

  if (intent === "unsatisfied") {
    await transitionTaskStatus(taskId, "Drafting", {
      expectedVersion: task.frontmatter.version,
      traceId: "waiting_human",
      messageId: "owner"
    });
    return {
      taskId,
      intent,
      statusChanged: true,
      nextStatus: "Drafting",
      message: "Moved back to Drafting for revision."
    };
  }

  if (intent === "closed") {
    await transitionTaskStatus(taskId, "Closed", {
      expectedVersion: task.frontmatter.version,
      traceId: "waiting_human",
      messageId: "owner"
    });
    return {
      taskId,
      intent,
      statusChanged: true,
      nextStatus: "Closed",
      message: "Task closed by human."
    };
  }

  if (intent === "enable_listener") {
    await transitionTaskStatus(taskId, "Listening", {
      expectedVersion: task.frontmatter.version,
      traceId: "waiting_human",
      messageId: "owner"
    });
    return {
      taskId,
      intent,
      statusChanged: true,
      nextStatus: "Listening",
      message: "Task moved to Listening (background)."
    };
  }

  if (intent === "friend_request") {
    await send_friend_request(taskId, task.frontmatter.current_partner_id);
    return {
      taskId,
      intent,
      statusChanged: false,
      nextStatus: task.frontmatter.status,
      message: "Friend request sent (placeholder)."
    };
  }

  return {
    taskId,
    intent,
    statusChanged: false,
    nextStatus: task.frontmatter.status,
    message: "Exit requested by user."
  };
}

/**
 * 处理入站握手协议消息（被动流）。
 *
 * 关键保证：幂等（idempotent）
 * - 若同一入站 envelope 重放，则直接返回历史 response（避免重复处理/重复状态迁移）
 *
 * 主要行为：
 * 1) 协议版本校验（当前仅支持 1.0）
 * 2) 幂等重放：`findIdempotencyRecord()`
 * 3) 记录 inbound/outbound 到 `agent_chat/*.jsonl`（便于复盘）
 * 4) 读取本地任务并根据 round/action/L2 决策进行状态迁移与响应生成
 * 5) 落盘幂等记录：`saveIdempotencyRecord()`
 *
 * 被使用位置：
 * - 当前代码库暂无直接引用（通常由网络层/协议层在收到对端消息时调用）
 */
/** Timeout for session-level L2 initial evaluation (10 seconds). */
const SESSION_INITIAL_TIMEOUT_MS = 10_000;
/** Timeout for session-level L2 multi-round negotiation (30 seconds). */
const SESSION_NEGOTIATING_TIMEOUT_MS = 30_000;

export async function dispatchInboundHandshake(envelope: HandshakeInboundEnvelope): Promise<HandshakeOutboundEnvelope> {
  const now = new Date().toISOString();

  if (envelope.protocol_version !== "1.0") {
    return buildErrorResponse(envelope, "E_PROTOCOL_VERSION_UNSUPPORTED", "Unsupported protocol version");
  }

  const replay = await findIdempotencyRecord(envelope);
  if (replay) {
    return replay.response;
  }

  await appendAgentChatLog(envelope.task_id, {
    direction: "inbound",
    timestamp: now,
    payload: envelope
  });

  let response: HandshakeOutboundEnvelope;

  try {
    const localTask = await readTaskDocument(envelope.task_id);

    // Listening tasks: autonomous session-based processing (task stays in Listening)
    if (localTask.frontmatter.status === "Listening") {
      response = await handleListeningHandshake(localTask, envelope, now);
    }
    // Negotiating tasks: allow replies from current_partner_id only
    else if (localTask.frontmatter.status === "Negotiating") {
      response = await handleNegotiatingHandshake(localTask, envelope, now);
    }
    // All other statuses: reject
    else {
      response = buildActionResponse(envelope, "CANCEL");
    }
  } catch (error) {
    response = buildErrorResponse(envelope, classifyErrorCode(error), normalizeErrorMessage(error));
  }

  try {
    await saveIdempotencyRecord(envelope, response);
  } catch {
    response = buildErrorResponse(envelope, "E_IDEMPOTENCY_CONFLICT", "Idempotency conflict");
  }

  await appendAgentChatLog(envelope.task_id, {
    direction: "outbound",
    timestamp: new Date().toISOString(),
    payload: response
  });

  return response;
}

/**
 * Handle inbound L2 handshake for a Listening task.
 * L0/L1 are already done by the sender (active flow). Listening only evaluates L2 (bilateral negotiation).
 * Task stays in Listening. Results accumulate in sessions for later report.
 */
async function handleListeningHandshake(
  localTask: TaskDocument,
  envelope: HandshakeInboundEnvelope,
  now: string
): Promise<HandshakeOutboundEnvelope> {
  if (envelope.action === "CANCEL") {
    // Mark existing session as rejected if one exists
    const existing = await findSessionByRemoteAgent(envelope.task_id, envelope.sender_agent_id);
    if (existing) {
      existing.status = "Rejected";
      existing.updated_at = now;
      await upsertNegotiationSession(existing);
    }
    return buildActionResponse(envelope, "CANCEL");
  }

  // Find or create a session for this remote agent
  let session = await findSessionByRemoteAgent(envelope.task_id, envelope.sender_agent_id);
  if (!session) {
    session = createNewSession(envelope, now, SESSION_INITIAL_TIMEOUT_MS);
  }

  // Check session timeout
  if (Date.now() > Date.parse(session.timeout_at)) {
    session.status = "Timeout";
    session.updated_at = now;
    await upsertNegotiationSession(session);
    return buildActionResponse(envelope, "REJECT");
  }

  // Round limit: reject if too many rounds
  if (envelope.round >= 5) {
    session.status = "Timeout";
    session.updated_at = now;
    session.rounds = envelope.round;
    await upsertNegotiationSession(session);
    return buildActionResponse(envelope, "REJECT");
  }

  // L2 bilateral evaluation: sender already passed us through their L0+L1, now we evaluate from our side
  const decision = await executeL2Sandbox(localTask, envelope);
  await appendScratchpadNote(envelope.task_id, decision.scratchpadNote, now);

  session.rounds = envelope.round + 1;
  session.updated_at = now;
  session.l2_action = decision.action;

  if (decision.action === "ACCEPT" && envelope.action === "ACCEPT") {
    // Bilateral accept: session complete
    session.status = "Accepted";
    session.match_score = computeMatchScore(localTask, envelope);
  } else if (decision.action === "REJECT") {
    session.status = "Rejected";
  } else {
    // Ongoing negotiation (PROPOSE/COUNTER_PROPOSE exchange)
    session.status = "Negotiating";
    session.timeout_at = new Date(Date.now() + SESSION_NEGOTIATING_TIMEOUT_MS).toISOString();
    session.match_score = computeMatchScore(localTask, envelope);
  }

  await upsertNegotiationSession(session);
  return buildActionResponse(envelope, decision.action);
}

/**
 * Handle handshake for a Negotiating task (active flow):
 * Only accept messages from current_partner_id.
 */
async function handleNegotiatingHandshake(
  localTask: TaskDocument,
  envelope: HandshakeInboundEnvelope,
  now: string
): Promise<HandshakeOutboundEnvelope> {
  // If task has a partner locked in, only accept from that partner
  if (localTask.frontmatter.current_partner_id && localTask.frontmatter.current_partner_id !== envelope.sender_agent_id) {
    return buildActionResponse(envelope, "REJECT");
  }

  if (envelope.action === "CANCEL") {
    await transitionTaskStatus(envelope.task_id, "Cancelled", { expectedVersion: localTask.frontmatter.version });
    return buildActionResponse(envelope, "CANCEL");
  }

  if (envelope.round >= 5) {
    await transitionTaskStatus(envelope.task_id, "Timeout", { expectedVersion: localTask.frontmatter.version });
    return buildActionResponse(envelope, "REJECT");
  }

  const decision = await executeL2Sandbox(localTask, envelope);
  await appendScratchpadNote(envelope.task_id, decision.scratchpadNote, now);

  if (decision.action === "ACCEPT" && envelope.action === "ACCEPT") {
    await transitionTaskStatus(envelope.task_id, "Waiting_Human", { expectedVersion: localTask.frontmatter.version });
    await notifyOwnerForHumanReview(envelope.task_id);
  }

  return buildActionResponse(envelope, decision.action);
}

function createNewSession(envelope: HandshakeInboundEnvelope, now: string, timeoutMs: number): NegotiationSession {
  return {
    session_id: randomUUID(),
    task_id: envelope.task_id,
    remote_agent_id: envelope.sender_agent_id,
    remote_task_id: envelope.task_id,
    status: "Negotiating",
    match_score: null,
    l2_action: null,
    rounds: 0,
    started_at: now,
    updated_at: now,
    timeout_at: new Date(Date.now() + timeoutMs).toISOString()
  };
}

/**
 * Compute a rough match score based on tag overlap and payload compatibility.
 * Returns 0.0-1.0. Used for report ranking.
 */
function computeMatchScore(localTask: TaskDocument, envelope: HandshakeInboundEnvelope): number {
  const interactionMatch =
    localTask.frontmatter.interaction_type === "any" ||
    envelope.payload.interaction_type === "any" ||
    localTask.frontmatter.interaction_type === envelope.payload.interaction_type
      ? 1.0
      : 0.0;

  const hasActivity = envelope.payload.target_activity.length > 0 ? 0.5 : 0;
  const hasVibe = envelope.payload.target_vibe.length > 0 ? 0.5 : 0;
  const contentScore = hasActivity + hasVibe;

  return Math.round((interactionMatch * 0.4 + contentScore * 0.6) * 100) / 100;
}

/**
 * L0：结构化硬过滤（只返回候选 taskId 列表 + 通过原因）。
 *
 * 过滤规则由 `queryL0Candidates()` 实现（interaction_type 兼容性）。
 */
export async function runL0Filter(task: TaskDocument): Promise<L0Candidate[]> {
  const candidateIds = await queryL0Candidates(task.frontmatter.task_id);
  return candidateIds.map((taskId) => ({
    taskId,
    reason: "L0 passed: tags/deal-breakers/interaction-type compatible"
  }));
}

/**
 * L1：语义检索与排序（把 L0 候选池送入语义相似度检索）。
 *
 * 实现要点：
 * - 先跑 L0，避免无意义的语义计算
 * - 候选池仅抽取 `targetActivity/targetVibe` 参与相似度计算
 * - 过滤阈值：只保留 `score >= 0.72` 的候选（当前为经验阈值）
 */
export async function runL1Retrieval(task: TaskDocument): Promise<L1Candidate[]> {
  const l0Candidates = await runL0Filter(task);
  if (l0Candidates.length === 0) {
    return [];
  }
  
  const semanticPool = await Promise.all(
    l0Candidates.map(async (candidate) => {
      const candidateTask = await readTaskDocument(candidate.taskId);
      return {
        taskId: candidate.taskId,
        targetActivity: candidateTask.body.targetActivity,
        targetVibe: candidateTask.body.targetVibe
      };
    })
  );

  const retrieved = await retrieveBySemanticSimilarity(
    {
      targetActivity: task.body.targetActivity,
      targetVibe: task.body.targetVibe,
      topK: 30
    },
    semanticPool
  );

  return retrieved.filter((candidate) => candidate.score >= 0.72);
}

/**
 * L2：本地研判沙盒（规则 + 用户画像 + 协议动作）。
 *
 * 输入：
 * - `task`：本地任务（真相源）
 * - `envelope`：对端入站握手消息（包含对端 payload）
 *
 * 输出：
 * - `action`：建议对端动作（ACCEPT/REJECT）
 * - `shouldMoveToRevising`：是否需要 owner 介入更新
 * - `scratchpadNote`：研判笔记（只写本地，不外发）
 */
export async function executeL2Sandbox(task: TaskDocument, envelope: HandshakeInboundEnvelope): Promise<L2Decision> {
  const userProfile = await readUserProfile();
  const interactionCompatible =
    task.frontmatter.interaction_type === "any" ||
    envelope.payload.interaction_type === "any" ||
    task.frontmatter.interaction_type === envelope.payload.interaction_type;

  if (envelope.action === "REJECT") {
    return {
      action: "REJECT",
      shouldMoveToRevising: false,
      scratchpadNote: "Peer rejected in L2; keep silent log only."
    };
  }

  if (envelope.action === "COUNTER_PROPOSE" && task.frontmatter.status === "Waiting_Human") {
    return {
      action: "REJECT",
      shouldMoveToRevising: true,
      scratchpadNote: `Counter-propose arrived in Waiting_Human. Mark Revising for owner update. UserProfilePreview=${userProfile.slice(0, 80)}`
    };
  }

  if (!interactionCompatible) {
    return {
      action: "REJECT",
      shouldMoveToRevising: false,
      scratchpadNote: "L2 conflict on interaction_type. Reject."
    };
  }

  const supportSignals =
    envelope.payload.target_activity.length > 0 &&
    envelope.payload.target_vibe.length > 0 &&
    ["PROPOSE", "COUNTER_PROPOSE", "ACCEPT"].includes(envelope.action);

  return {
    action: supportSignals ? "ACCEPT" : "REJECT",
    shouldMoveToRevising: false,
    scratchpadNote: `L2 evaluated with action=${envelope.action}; support=${supportSignals}; userProfileChars=${userProfile.length}`
  };
}

/**
 * 向对端发送初始 propose（出站握手）。
 *
 * 约定（按你当前需求）：
 * - “只要发送成功”就视为进入协商阶段（由上层把状态迁移到 Negotiating）
 * - 暂不处理 response（Waiting_Human 等更精细的推进后续再补）
 *
 * 当前实现：
 * - 永远会先把出站 envelope 记录到本地 `agent_chat` 日志（便于复盘）
 * - 若配置了 `TASK_AGENT_PEER_HANDSHAKE_URL`，会尝试 HTTP POST（带超时）
 * - 若未配置 URL，则视为“占位发送成功”，保证状态机联调可继续推进
 */
async function sendInitialPropose(sourceTaskId: string, targetTaskId: string): Promise<boolean> {
  const sourceTask = await readTaskDocument(sourceTaskId);
  const now = new Date().toISOString();

  const envelope: HandshakeInboundEnvelope = {
    protocol_version: "1.0",
    message_id: randomUUID(),
    // 占位：未来应为本 agent 的稳定 ID（例如机器指纹/配置项）。
    sender_agent_id: "local",
    // 占位：当前候选只有 taskId，暂用 taskId 充当 receiver 标识；未来应为对端 agent_id。
    receiver_agent_id: targetTaskId,
    // 约定：用发起方本地 task_id 作为会话 ID（双方一致性策略后续再明确）。
    task_id: sourceTaskId,
    action: "PROPOSE",
    round: 0,
    payload: {
      interaction_type: sourceTask.frontmatter.interaction_type,
      target_activity: sourceTask.body.targetActivity,
      target_vibe: sourceTask.body.targetVibe
    },
    timestamp: now,
    signature: "local-placeholder-signature"
  };

  // 先落盘：即使真实网络发送失败，也能看到“我尝试发起过什么”。
  await appendAgentChatLog(sourceTaskId, { direction: "outbound", timestamp: now, payload: envelope });

  try {
    await postHandshakeToPeer(envelope);
    return true;
  } catch (error) {
    // 再落一条失败原因，方便本地排障（不抛给上层，交由上层决定是否重试/回退）。
    await appendAgentChatLog(sourceTaskId, {
      direction: "outbound",
      timestamp: new Date().toISOString(),
      payload: { event: "propose_send_failed", reason: normalizeErrorMessage(error) }
    });
    return false;
  }
}

/** 通知 owner 进入人工审核（占位实现，例如发 IM/邮件/系统通知）。 */
async function notifyOwnerForHumanReview(_taskId: string): Promise<void> {
  // Placeholder: notification integration will be implemented in later phases.
}

/**
 * 出站握手发送（HTTP 占位实现）。
 *
 * - 若未配置 `TASK_AGENT_PEER_HANDSHAKE_URL`：直接视为发送成功（占位），方便你先跑通状态机
 * - 若配置了 URL：尝试 HTTP POST JSON（带 5s 超时）；非 2xx 视为失败
 *
 * 注意：当前不解析对端 response（你说暂时不用 response 机制）。
 */
async function postHandshakeToPeer(envelope: HandshakeInboundEnvelope): Promise<void> {
  const url = process.env.TASK_AGENT_PEER_HANDSHAKE_URL;
  if (!url || url.trim().length === 0) {
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(envelope),
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`E_PEER_HTTP_${res.status}: handshake POST failed`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 构造握手协议的“动作响应”。
 * - `in_reply_to` 关联入站 `message_id`
 * - `message_id` 为本端新生成的唯一 ID
 */
function buildActionResponse(
  envelope: HandshakeInboundEnvelope,
  action: "ACCEPT" | "REJECT" | "CANCEL"
): HandshakeOutboundEnvelope {
  return {
    protocol_version: "1.0",
    message_id: randomUUID(),
    in_reply_to: envelope.message_id,
    task_id: envelope.task_id,
    action,
    error: null,
    timestamp: new Date().toISOString()
  };
}

/**
 * 构造握手协议的“错误响应”（`action=ERROR`）。
 * 注意：错误码来自 `ErrorCode`（schema 约束）。
 */
function buildErrorResponse(
  envelope: HandshakeInboundEnvelope,
  code: ErrorCode,
  message: string
): HandshakeOutboundEnvelope {
  return {
    protocol_version: "1.0",
    message_id: randomUUID(),
    in_reply_to: envelope.message_id,
    task_id: envelope.task_id,
    action: "ERROR",
    error: {
      code,
      message
    },
    timestamp: new Date().toISOString()
  };
}

/** 小工具：判断当前状态是否属于给定集合。 */
function isStatusOneOf(status: TaskStatus, statuses: TaskStatus[]): boolean {
  return statuses.includes(status);
}

function formatHandshakeSummary(
  task: TaskDocument,
  snapshot: Awaited<ReturnType<typeof readLatestHandshakeExchange>>
): string {
  const lines: string[] = [];
  lines.push(`task_id: ${task.frontmatter.task_id}`);
  lines.push(`status: ${task.frontmatter.status}`);
  lines.push(`target_activity: ${task.body.targetActivity}`);
  lines.push(`target_vibe: ${task.body.targetVibe}`);

  if (!snapshot.inbound && !snapshot.outbound) {
    lines.push("");
    lines.push("（未读取到握手日志：可能尚未写入 agent_chat，或日志文件为空）");
    return lines.join("\n");
  }

  if (snapshot.sourceFilePath) {
    lines.push(`agent_chat_source: ${snapshot.sourceFilePath}`);
  }

  if (snapshot.inbound) {
    lines.push("");
    lines.push("[Inbound]");
    lines.push(`from: ${snapshot.inbound.sender_agent_id} -> ${snapshot.inbound.receiver_agent_id}`);
    lines.push(`action: ${snapshot.inbound.action}  round: ${snapshot.inbound.round}`);
    lines.push(`interaction_type: ${snapshot.inbound.payload.interaction_type}`);
    lines.push(`target_activity: ${snapshot.inbound.payload.target_activity}`);
    lines.push(`target_vibe: ${snapshot.inbound.payload.target_vibe}`);
    lines.push(`timestamp: ${snapshot.inbound.timestamp}`);
  }

  if (snapshot.outbound) {
    lines.push("");
    lines.push("[Outbound]");
    lines.push(`action: ${snapshot.outbound.action}`);
    if (snapshot.outbound.error) {
      lines.push(`error: ${snapshot.outbound.error.code} - ${snapshot.outbound.error.message}`);
    } else {
      lines.push("error: null");
    }
    lines.push(`timestamp: ${snapshot.outbound.timestamp}`);
  }

  return lines.join("\n");
}

/** 将异常对象归一化为可对外展示的错误消息文本。 */
function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "Internal error";
}

/**
 * 将异常消息映射为协议错误码（粗粒度分类）。
 * - 版本冲突：`E_VERSION_CONFLICT`（乐观锁失败）
 * - 派生层不可用：`E_DEP_UNAVAILABLE`
 * - 其他：`E_INTERNAL`
 */
function classifyErrorCode(error: unknown): ErrorCode {
  const message = normalizeErrorMessage(error);
  if (message.includes("E_VERSION_CONFLICT")) {
    return "E_VERSION_CONFLICT";
  }
  if (message.includes("E_DEP_UNAVAILABLE")) {
    return "E_DEP_UNAVAILABLE";
  }
  return "E_INTERNAL";
}
