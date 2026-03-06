import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { TaskDocument } from "./schema";

const DATA_ROOT = path.resolve(process.cwd(), ".data");
const SQLITE_DB_PATH = path.join(DATA_ROOT, "task_agent.db");

mkdirSync(DATA_ROOT, { recursive: true });

const db = new Database(SQLITE_DB_PATH, { timeout: 3000 });
try {
  db.pragma("journal_mode = WAL");
} catch {
  // Ignore pragma race/lock at startup; DB remains usable with default journal mode.
}

db.exec(`
CREATE TABLE IF NOT EXISTS task_snapshots (
  task_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  task_path TEXT NOT NULL,
  task_json TEXT NOT NULL,
  synced_at TEXT NOT NULL
);
`);

try {
  db.exec("ALTER TABLE task_snapshots ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;");
} catch {
  // Column already exists.
}

const upsertTaskSnapshotStmt = db.prepare(`
INSERT INTO task_snapshots (task_id, status, hidden, version, updated_at, task_path, task_json, synced_at)
VALUES (@task_id, @status, @hidden, @version, @updated_at, @task_path, @task_json, @synced_at)
ON CONFLICT(task_id) DO UPDATE SET
  status = excluded.status,
  hidden = excluded.hidden,
  version = excluded.version,
  updated_at = excluded.updated_at,
  task_path = excluded.task_path,
  task_json = excluded.task_json,
  synced_at = excluded.synced_at
`);

const selectAllTaskSnapshotsStmt = db.prepare(`
SELECT task_id, status, hidden, version, updated_at, task_path, task_json, synced_at
FROM task_snapshots
ORDER BY updated_at DESC
`);

const selectTaskSnapshotByIdStmt = db.prepare(`
SELECT task_id, status, hidden, version, updated_at, task_path, task_json, synced_at
FROM task_snapshots
WHERE task_id = ?
LIMIT 1
`);

const countTaskSnapshotsStmt = db.prepare("SELECT COUNT(*) as count FROM task_snapshots");

export interface SqliteTaskSnapshotRow {
  task_id: string;
  status: string;
  hidden: number;
  version: number;
  updated_at: string;
  task_path: string;
  task_json: string;
  synced_at: string;
}

export function upsertTaskSnapshot(task: TaskDocument, taskPath: string, syncedAt = new Date().toISOString()): void {
  upsertTaskSnapshotStmt.run({
    task_id: task.frontmatter.task_id,
    status: task.frontmatter.status,
    hidden: task.frontmatter.hidden ? 1 : 0,
    version: task.frontmatter.version,
    updated_at: task.frontmatter.updated_at,
    task_path: taskPath,
    task_json: JSON.stringify(task),
    synced_at: syncedAt
  });
}

export function listTaskSnapshots(): SqliteTaskSnapshotRow[] {
  return selectAllTaskSnapshotsStmt.all() as SqliteTaskSnapshotRow[];
}

export function readTaskSnapshot(taskId: string): SqliteTaskSnapshotRow | null {
  const row = selectTaskSnapshotByIdStmt.get(taskId) as SqliteTaskSnapshotRow | undefined;
  return row ?? null;
}

export function sqliteHealth(): { dbPath: string; taskCount: number } {
  const row = countTaskSnapshotsStmt.get() as { count: number };
  return {
    dbPath: SQLITE_DB_PATH,
    taskCount: row.count
  };
}
