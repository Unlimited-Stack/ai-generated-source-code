import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { getListeningReportForTask, getWaitingHumanSummary, handleWaitingHumanIntent, type WaitingHumanIntent } from "./dispatcher";
import type { ListeningReport } from "./util/schema";
import { startListener } from "./listener";
import { createDraftTaskFromUserQueryIfAvailable, runTaskStepById } from "./task_loop";
import { getTaskFilePath, listAllTasks, readTaskDocument, setTaskHidden, transitionTaskStatus } from "./util/storage";
import type { TaskStatus } from "./util/schema";

const TERMINAL_STATUSES: readonly TaskStatus[] = ["Closed", "Failed", "Timeout", "Cancelled"] as const;

/**
 * Runtime shell:
 * - Supports multiple tasks in storage.
 * - Enforces one active task for user operations at a time.
 * - Keeps listener as a global switch to accept inbound handshakes for all tasks.
 */
export async function startTaskAgentRuntime(): Promise<void> {
  if (!input.isTTY) {
    await startListener();
    return;
  }

  const rl = createInterface({ input, output });
  let activeTaskId: string | null = null;

  try {
    await startListener();
    output.write("listener service: on\n");
    printHelp();
    while (true) {
      const prompt = activeTaskId ? `\nruntime(${activeTaskId})> ` : "\nruntime> ";
      const line = (await rl.question(prompt)).trim();
      if (!line) {
        continue;
      }

      const [command, ...args] = line.split(/\s+/);

      if (command === "help") {
        printHelp();
        continue;
      }

      if (command === "list") {
        await printTaskStatusSummary(args[0] === "all");
        continue;
      }

      if (command === "new") {
        const taskId = await createDraftTaskFromUserQueryIfAvailable();
        if (taskId) {
          activeTaskId = taskId;
          output.write(`创建成功并设为当前任务: ${taskId}\n`);
        }
        continue;
      }

      if (command === "select") {
        const taskId = args[0];
        if (!taskId) {
          output.write("用法：select <taskId>\n");
          continue;
        }
        try {
          await readTaskDocument(taskId);
          activeTaskId = taskId;
          output.write(`当前任务已切换为: ${taskId}\n`);
        } catch (error) {
          output.write(`select 失败：${normalizeErrorMessage(error)}\n`);
        }
        continue;
      }

      if (command === "active") {
        output.write(`activeTaskId: ${activeTaskId ?? "(未选择)"}\n`);
        continue;
      }

      if (command === "run") {
        if (!activeTaskId) {
          output.write("请先 select 一个 task，再执行 run。\n");
          continue;
        }
        await runActiveTaskStep(activeTaskId, rl);
        continue;
      }

      if (command === "end") {
        const taskId = args[0] ?? activeTaskId;
        if (!taskId) {
          output.write("用法：end <taskId>（或先 select 再 end）\n");
          continue;
        }
        await markTaskEnded(taskId);
        if (activeTaskId === taskId) {
          activeTaskId = null;
        }
        continue;
      }

      if (command === "cancel") {
        const taskId = args[0] ?? activeTaskId;
        if (!taskId) {
          output.write("用法：cancel <taskId>（或先 select 再 cancel）\n");
          continue;
        }
        await cancelTask(taskId);
        if (activeTaskId === taskId) {
          activeTaskId = null;
        }
        continue;
      }

      if (command === "listen") {
        const taskId = args[0] ?? activeTaskId;
        if (!taskId) {
          output.write("用法：listen [taskId]（将任务挂起为 Listening 后台模式）\n");
          continue;
        }
        try {
          const task = await readTaskDocument(taskId);
          await transitionTaskStatus(taskId, "Listening", {
            expectedVersion: task.frontmatter.version,
            traceId: "runtime",
            messageId: "owner"
          });
          output.write(`任务已挂起为 Listening：${taskId}\n`);
          if (activeTaskId === taskId) {
            activeTaskId = null;
          }
        } catch (error) {
          output.write(`listen 失败：${normalizeErrorMessage(error)}\n`);
        }
        continue;
      }

      if (command === "unlisten") {
        const taskId = args[0] ?? activeTaskId;
        if (!taskId) {
          output.write("用法：unlisten [taskId]（停止监听，回到 Waiting_Human）\n");
          continue;
        }
        try {
          // Generate and display listening report before transitioning
          const report = await getListeningReportForTask(taskId);
          printListeningReport(report);

          const task = await readTaskDocument(taskId);
          await transitionTaskStatus(taskId, "Waiting_Human", {
            expectedVersion: task.frontmatter.version,
            traceId: "runtime",
            messageId: "owner"
          });
          activeTaskId = taskId;
          output.write(`已停止监听，回到 Waiting_Human：${taskId}\n`);
        } catch (error) {
          output.write(`unlisten 失败：${normalizeErrorMessage(error)}\n`);
        }
        continue;
      }

      if (command === "report") {
        const taskId = args[0] ?? activeTaskId;
        if (!taskId) {
          output.write("用法：report [taskId]（查看 Listening 期间的协商报告）\n");
          continue;
        }
        try {
          const report = await getListeningReportForTask(taskId);
          printListeningReport(report);
        } catch (error) {
          output.write(`report 失败：${normalizeErrorMessage(error)}\n`);
        }
        continue;
      }

      if (command === "reopen") {
        const taskId = args[0] ?? activeTaskId;
        if (!taskId) {
          output.write("用法：reopen [taskId]（重开已结束的任务 → Waiting_Human）\n");
          continue;
        }
        try {
          const task = await readTaskDocument(taskId);
          await transitionTaskStatus(taskId, "Waiting_Human", {
            expectedVersion: task.frontmatter.version,
            traceId: "runtime",
            messageId: "owner"
          });
          activeTaskId = taskId;
          output.write(`任务已重开为 Waiting_Human：${taskId}\n`);
        } catch (error) {
          output.write(`reopen 失败：${normalizeErrorMessage(error)}\n`);
        }
        continue;
      }

      if (command === "hide") {
        const taskId = args[0] ?? activeTaskId;
        if (!taskId) {
          output.write("用法：hide [taskId]（前端隐藏任务，后台数据保留）\n");
          continue;
        }
        try {
          await setTaskHidden(taskId, true);
          output.write(`任务已隐藏：${taskId}\n`);
          if (activeTaskId === taskId) {
            activeTaskId = null;
          }
        } catch (error) {
          output.write(`hide 失败：${normalizeErrorMessage(error)}\n`);
        }
        continue;
      }

      if (command === "unhide") {
        const taskId = args[0];
        if (!taskId) {
          output.write("用法：unhide <taskId>（取消隐藏任务）\n");
          continue;
        }
        try {
          await setTaskHidden(taskId, false);
          output.write(`任务已取消隐藏：${taskId}\n`);
        } catch (error) {
          output.write(`unhide 失败：${normalizeErrorMessage(error)}\n`);
        }
        continue;
      }

      if (command === "path") {
        const taskId = args[0] ?? activeTaskId;
        if (!taskId) {
          output.write("用法：path <taskId>（或先 select 再 path）\n");
          continue;
        }
        try {
          const path = await getTaskFilePath(taskId);
          output.write(`${path}\n`);
        } catch (error) {
          output.write(`path 失败：${normalizeErrorMessage(error)}\n`);
        }
        continue;
      }

      if (command === "exit" || command === "quit") {
        output.write("退出 runtime。\n");
        break;
      }

      output.write(`未知命令：${command}（输入 help 查看可用命令）\n`);
    }
  } finally {
    rl.close();
  }
}

async function runActiveTaskStep(taskId: string, rl: ReturnType<typeof createInterface>): Promise<void> {
  try {
    const task = await readTaskDocument(taskId);
    if (task.frontmatter.status === "Waiting_Human") {
      const summary = await getWaitingHumanSummary(taskId);
      output.write(
        [
          "",
          `task_id: ${summary.taskId}`,
          `status: ${summary.status}`,
          `target_activity: ${summary.targetActivity}`,
          `target_vibe: ${summary.targetVibe}`
        ].join("\n") + "\n"
      );

      const intentRaw = (await rl.question("Waiting_Human 意图：satisfied / unsatisfied / enable_listener / friend_request / closed / exit："))
        .trim()
        .toLowerCase();
      if (!isWaitingHumanIntent(intentRaw)) {
        output.write("意图无效，已跳过。\n");
        return;
      }

      const result = await handleWaitingHumanIntent(taskId, intentRaw);
      output.write(`${result.message}\n`);
      return;
    }

    const result = await runTaskStepById(taskId, rl);
    if (!result.handled) {
      output.write(`当前状态 ${result.previousStatus} 非可运行状态。\n`);
      return;
    }
    if (result.changed) {
      output.write(`状态已推进：${result.previousStatus} -> ${result.currentStatus}\n`);
      return;
    }
    output.write(`状态保持不变：${result.currentStatus}\n`);
  } catch (error) {
    output.write(`run 失败：${normalizeErrorMessage(error)}\n`);
  }
}

async function markTaskEnded(taskId: string): Promise<void> {
  try {
    const task = await readTaskDocument(taskId);
    if (TERMINAL_STATUSES.includes(task.frontmatter.status)) {
      output.write(`任务已是终态：${task.frontmatter.status}\n`);
      return;
    }

    if (task.frontmatter.status !== "Waiting_Human") {
      output.write(`end 仅在 Waiting_Human 阶段可用（当前：${task.frontmatter.status}）。如需放弃任务请用 cancel。\n`);
      return;
    }

    await transitionTaskStatus(taskId, "Closed", {
      expectedVersion: task.frontmatter.version,
      traceId: "runtime",
      messageId: "owner"
    });
    output.write("任务已结束：Closed（保留数据）。\n");
  } catch (error) {
    output.write(`end 失败：${normalizeErrorMessage(error)}\n`);
  }
}

async function cancelTask(taskId: string): Promise<void> {
  try {
    const task = await readTaskDocument(taskId);
    if (TERMINAL_STATUSES.includes(task.frontmatter.status)) {
      output.write(`任务已是终态：${task.frontmatter.status}\n`);
      return;
    }

    await transitionTaskStatus(taskId, "Cancelled", {
      expectedVersion: task.frontmatter.version,
      traceId: "runtime",
      messageId: "owner"
    });
    output.write("任务已放弃：Cancelled（保留数据）。\n");
  } catch (error) {
    output.write(`cancel 失败：${normalizeErrorMessage(error)}\n`);
  }
}

async function printTaskStatusSummary(showAll = false): Promise<void> {
  const records = await listAllTasks();
  const visible = showAll ? records : records.filter((r) => !r.task.frontmatter.hidden);
  if (visible.length === 0) {
    output.write(showAll ? "当前没有任务。\n" : "当前没有可见任务（可用 list all 查看全部）。\n");
    return;
  }

  output.write("\n任务状态概览：\n");
  for (const record of visible) {
    const hidden = record.task.frontmatter.hidden ? " [hidden]" : "";
    output.write(`- ${record.task.frontmatter.task_id} | ${record.task.frontmatter.status} | v${record.task.frontmatter.version}${hidden}\n`);
  }
}

function printHelp(): void {
  output.write(
    [
      "\n可用命令：",
      "- help                    显示帮助",
      "- list [all]              列出可见任务（all 显示含隐藏）",
      "- new                     创建新任务并设为 active",
      "- select <taskId>         选择当前可操作任务",
      "- active                  查看当前 active 任务",
      "- run                     对 active 任务执行一步 FSM",
      "- end [taskId]            正常结束任务（仅 Waiting_Human → Closed）",
      "- cancel [taskId]         放弃任务（任意非终态 → Cancelled）",
      "- listen [taskId]         挂起任务到后台监听（Waiting_Human → Listening）",
      "- unlisten [taskId]       停止监听并查看报告（Listening → Waiting_Human）",
      "- report [taskId]         查看 Listening 期间的协商报告",
      "- reopen [taskId]         重开已结束任务（Closed/Cancelled → Waiting_Human）",
      "- hide [taskId]           隐藏任务（前端不可见，数据保留）",
      "- unhide <taskId>         取消隐藏",
      "- path [taskId]           打印 task.md 路径",
      "- exit|quit               退出 runtime"
    ].join("\n") + "\n"
  );
}


function printListeningReport(report: ListeningReport): void {
  output.write("\n===== Listening 协商报告 =====\n");
  output.write(`task_id: ${report.task_id}\n`);
  output.write(`总握手数: ${report.total_handshakes}\n`);
  output.write(`  accepted: ${report.accepted}  rejected: ${report.rejected}  timeout: ${report.timed_out}\n`);

  if (report.sessions.length === 0) {
    output.write("（Listening 期间未收到任何握手请求）\n");
    return;
  }

  output.write("\n协商明细（按匹配度排序）：\n");
  for (const s of report.sessions) {
    const score = s.match_score !== null ? `${(s.match_score * 100).toFixed(0)}%` : "N/A";
    output.write(`  [${s.status}] agent=${s.remote_agent_id}  score=${score}  rounds=${s.rounds}  l2=${s.l2_action ?? "-"}\n`);
  }
  output.write(`报告生成时间: ${report.generated_at}\n`);
}

function isWaitingHumanIntent(value: string): value is WaitingHumanIntent {
  return value === "satisfied" || value === "unsatisfied" || value === "enable_listener" || value === "closed" || value === "friend_request" || value === "exit";
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "Internal error";
}
