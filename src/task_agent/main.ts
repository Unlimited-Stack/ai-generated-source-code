import "dotenv/config";
import { startTaskAgentRuntime as startRuntime } from "./runtime";

/**
 * Task-agent scoped bootstrap used by integration tests or future workers.
 */
export async function startTaskAgentRuntime(): Promise<void> {
  await startRuntime();
}
