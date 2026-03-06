import type { Interface } from "node:readline/promises";
import { collectInitialTaskFromUser } from "./intake";
import { processDraftingTask, processSearchingTask, processWaitingHumanTask } from "./dispatcher";
import { appendRawChat, appendRawChatSummary, readTaskDocument, saveTaskMD } from "./util/storage";
import type { TaskDocument, TaskStatus } from "./util/schema";

type RunnableTaskState = "Drafting" | "Revising" | "Searching" | "Waiting_Human";

interface StartTaskLoopOptions {
  activeTaskId?: string | null;
  startNewTaskIfAvailable?: boolean;
  readline?: Interface;
  continuous?: boolean;
  idleSleepMs?: number;
}

export interface TaskStepResult {
  taskId: string;
  previousStatus: TaskStatus;
  currentStatus: TaskStatus;
  handled: boolean;
  changed: boolean;
}

/**
 * Active flow task-loop engine.
 * Contract: never perform file/database I/O directly in this module.
 */
export async function startTaskLoop(options: StartTaskLoopOptions = {}): Promise<void> {
  const activeTaskId = options.activeTaskId ?? null;
  const startNewTaskIfAvailable = options.startNewTaskIfAvailable ?? false;
  const readline = options.readline;
  const continuous = options.continuous ?? false;
  const idleSleepMs = options.idleSleepMs ?? 1000;

  while (true) {
    let taskId = activeTaskId;
    if (!taskId && startNewTaskIfAvailable) {
      taskId = await createDraftTaskFromUserQueryIfAvailable();
    }

    let progress = false;
    if (taskId) {
      const result = await runTaskStepById(taskId, readline);
      progress = result.changed;
    }

    if (!continuous) {
      return;
    }

    if (!progress) {
      await sleep(idleSleepMs);
    }
  }
}

export async function createDraftTaskFromUserQueryIfAvailable(): Promise<string | null> {
  const intake = await collectInitialTaskFromUser();
  if (!intake) {
    return null;
  }

  const timestamp = new Date().toISOString();
  await saveTaskMD(intake.task);

  const transcriptText = intake.transcript.join("\n\n");
  await appendRawChat(intake.task.frontmatter.task_id, transcriptText, timestamp);
  await appendRawChatSummary(
    `# Intake Summary\n\ntask_id: ${intake.task.frontmatter.task_id}\n\n${intake.task.body.rawDescription}`,
    timestamp
  );
  return intake.task.frontmatter.task_id;
}

export async function runTaskStepById(taskId: string, rl?: Interface): Promise<TaskStepResult> {
  const task = await readTaskDocument(taskId);
  const changed = await runTaskStep(task, rl);
  const latest = changed ? await readTaskDocument(taskId) : task;
  const handled = isRunnableStatus(task.frontmatter.status);
  return {
    taskId,
    previousStatus: task.frontmatter.status,
    currentStatus: latest.frontmatter.status,
    handled,
    changed
  };
}

export async function runTaskStep(task: TaskDocument, rl?: Interface): Promise<boolean> {
  switch (task.frontmatter.status) {
    case "Drafting":
    case "Revising":
      return processDraftingTask(task);
    case "Searching":
      return processSearchingTask(task);
    case "Waiting_Human":
      return processWaitingHumanTask(task, rl);
    default:
      return false;
  }
}

function isRunnableStatus(status: TaskStatus): status is RunnableTaskState {
  return status === "Drafting" || status === "Revising" || status === "Searching" || status === "Waiting_Human";
}//

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
