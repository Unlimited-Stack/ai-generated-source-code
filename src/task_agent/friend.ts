/**
 * 好友/聊天阶段入口（占位）。
 *
 * 该文件用于承接 Waiting_Human 阶段“用户确认满意后”的下一步流程。
 * 你后续可以在这里实现真正的聊天逻辑（例如启动对话 UI、连接对端 agent、记录聊天等）。
 *
 * 当前阶段只保留函数签名，避免阻塞状态机其他部分的联调。
 */

export async function start_chat(_taskId: string): Promise<void> {
  // TODO: implement in later phase.
  // Will launch a chat session with the matched agent.
}

export async function send_friend_request(_taskId: string, _partnerId: string | null): Promise<void> {
  // TODO: implement in later phase.
  // Will send a friend/connection request to the matched agent's user.
}

