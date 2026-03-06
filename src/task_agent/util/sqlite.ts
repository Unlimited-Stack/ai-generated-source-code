import { mkdirSync } from "node:fs";
import path from "node:path";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import type { TaskDocument } from "./schema";

// ---------------------------------------------------------------------------
// Database initialization
// ---------------------------------------------------------------------------

const DATA_ROOT = path.resolve(process.cwd(), ".data");
const SQLITE_DB_PATH = path.join(DATA_ROOT, "task_agent.db");

mkdirSync(DATA_ROOT, { recursive: true });

const db: DatabaseType = new Database(SQLITE_DB_PATH, { timeout: 3000 });
try {
  db.pragma("journal_mode = WAL");
} catch {
  // Ignore pragma race/lock at startup; DB remains usable with default journal mode.
}

// ---------------------------------------------------------------------------
// Global task index table (lightweight index for cross-task queries)
// ---------------------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS task_index (
  task_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  interaction_type TEXT NOT NULL DEFAULT 'any',
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  task_path TEXT NOT NULL,
  synced_at TEXT NOT NULL
);
`);

// ---------------------------------------------------------------------------
// Per-task table helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize task_id into a safe SQLite table suffix.
 * E.g. "T-abc-123" -> "t_abc_123"
 */
function tableSuffix(taskId: string): string {
  return taskId.toLowerCase().replace(/[^a-z0-9]/g, "_");
}

function frontmatterTable(taskId: string): string {
  return `task_fm_${tableSuffix(taskId)}`;
}

function bodyTable(taskId: string): string {
  return `task_body_${tableSuffix(taskId)}`;
}

function vectorTable(taskId: string): string {
  return `task_vec_${tableSuffix(taskId)}`;
}

/**
 * Ensure per-task tables exist. Idempotent.
 */
function ensureTaskTables(taskId: string): void {
  const fm = frontmatterTable(taskId);
  const bd = bodyTable(taskId);
  const vec = vectorTable(taskId);

  db.exec(`
    CREATE TABLE IF NOT EXISTS "${fm}" (
      task_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      interaction_type TEXT NOT NULL,
      current_partner_id TEXT,
      entered_status_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL,
      pending_sync INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS "${bd}" (
      task_id TEXT PRIMARY KEY,
      raw_description TEXT NOT NULL,
      target_activity TEXT NOT NULL,
      target_vibe TEXT NOT NULL,
      detailed_plan TEXT NOT NULL DEFAULT ''
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS "${vec}" (
      task_id TEXT NOT NULL,
      field TEXT NOT NULL CHECK(field IN ('targetActivity', 'targetVibe', 'rawDescription')),
      source_text TEXT NOT NULL,
      vector_blob BLOB NOT NULL,
      dimensions INTEGER NOT NULL,
      model TEXT NOT NULL DEFAULT 'text-embedding-v4',
      created_at TEXT NOT NULL,
      PRIMARY KEY (task_id, field)
    );
  `);
}

// ---------------------------------------------------------------------------
// Per-task CRUD: frontmatter
// ---------------------------------------------------------------------------

export function upsertTaskFrontmatter(task: TaskDocument): void {
  const taskId = task.frontmatter.task_id;
  ensureTaskTables(taskId);
  const tbl = frontmatterTable(taskId);

  db.prepare(`
    INSERT INTO "${tbl}" (task_id, status, interaction_type, current_partner_id, entered_status_at, created_at, updated_at, version, pending_sync, hidden)
    VALUES (@task_id, @status, @interaction_type, @current_partner_id, @entered_status_at, @created_at, @updated_at, @version, @pending_sync, @hidden)
    ON CONFLICT(task_id) DO UPDATE SET
      status = excluded.status,
      interaction_type = excluded.interaction_type,
      current_partner_id = excluded.current_partner_id,
      entered_status_at = excluded.entered_status_at,
      updated_at = excluded.updated_at,
      version = excluded.version,
      pending_sync = excluded.pending_sync,
      hidden = excluded.hidden
  `).run({
    task_id: taskId,
    status: task.frontmatter.status,
    interaction_type: task.frontmatter.interaction_type,
    current_partner_id: task.frontmatter.current_partner_id,
    entered_status_at: task.frontmatter.entered_status_at,
    created_at: task.frontmatter.created_at,
    updated_at: task.frontmatter.updated_at,
    version: task.frontmatter.version,
    pending_sync: task.frontmatter.pending_sync ? 1 : 0,
    hidden: task.frontmatter.hidden ? 1 : 0
  });
}

// ---------------------------------------------------------------------------
// Per-task CRUD: body
// ---------------------------------------------------------------------------

export function upsertTaskBody(task: TaskDocument): void {
  const taskId = task.frontmatter.task_id;
  ensureTaskTables(taskId);
  const tbl = bodyTable(taskId);

  db.prepare(`
    INSERT INTO "${tbl}" (task_id, raw_description, target_activity, target_vibe, detailed_plan)
    VALUES (@task_id, @raw_description, @target_activity, @target_vibe, @detailed_plan)
    ON CONFLICT(task_id) DO UPDATE SET
      raw_description = excluded.raw_description,
      target_activity = excluded.target_activity,
      target_vibe = excluded.target_vibe,
      detailed_plan = excluded.detailed_plan
  `).run({
    task_id: taskId,
    raw_description: task.body.rawDescription,
    target_activity: task.body.targetActivity,
    target_vibe: task.body.targetVibe,
    detailed_plan: task.body.detailedPlan ?? ""
  });
}

// ---------------------------------------------------------------------------
// Per-task CRUD: vectors
// ---------------------------------------------------------------------------

export interface VectorRecord {
  task_id: string;
  field: "targetActivity" | "targetVibe" | "rawDescription";
  source_text: string;
  vector: number[];
  dimensions: number;
  model: string;
  created_at: string;
}

/**
 * Store a single field's embedding vector for a task.
 * Vectors are stored as Float32Array blobs (industry standard for embeddings).
 */
export function upsertTaskVector(
  taskId: string,
  field: "targetActivity" | "targetVibe" | "rawDescription",
  sourceText: string,
  vector: number[],
  model = "text-embedding-v4"
): void {
  ensureTaskTables(taskId);
  const tbl = vectorTable(taskId);
  const blob = Buffer.from(new Float32Array(vector).buffer);

  db.prepare(`
    INSERT INTO "${tbl}" (task_id, field, source_text, vector_blob, dimensions, model, created_at)
    VALUES (@task_id, @field, @source_text, @vector_blob, @dimensions, @model, @created_at)
    ON CONFLICT(task_id, field) DO UPDATE SET
      source_text = excluded.source_text,
      vector_blob = excluded.vector_blob,
      dimensions = excluded.dimensions,
      model = excluded.model,
      created_at = excluded.created_at
  `).run({
    task_id: taskId,
    field,
    source_text: sourceText,
    vector_blob: blob,
    dimensions: vector.length,
    model,
    created_at: new Date().toISOString()
  });
}

/**
 * Read a single field's vector for a task. Returns null if not found.
 */
export function readTaskVector(
  taskId: string,
  field: "targetActivity" | "targetVibe" | "rawDescription"
): VectorRecord | null {
  ensureTaskTables(taskId);
  const tbl = vectorTable(taskId);

  const row = db.prepare(`
    SELECT task_id, field, source_text, vector_blob, dimensions, model, created_at
    FROM "${tbl}" WHERE task_id = ? AND field = ?
  `).get(taskId, field) as { task_id: string; field: string; source_text: string; vector_blob: Buffer; dimensions: number; model: string; created_at: string } | undefined;

  if (!row) return null;

  const float32 = new Float32Array(row.vector_blob.buffer, row.vector_blob.byteOffset, row.dimensions);
  return {
    task_id: row.task_id,
    field: row.field as VectorRecord["field"],
    source_text: row.source_text,
    vector: Array.from(float32),
    dimensions: row.dimensions,
    model: row.model,
    created_at: row.created_at
  };
}

/**
 * Read all vectors for a task (up to 3 fields).
 */
export function readAllTaskVectors(taskId: string): VectorRecord[] {
  ensureTaskTables(taskId);
  const tbl = vectorTable(taskId);

  const rows = db.prepare(`
    SELECT task_id, field, source_text, vector_blob, dimensions, model, created_at
    FROM "${tbl}" WHERE task_id = ?
  `).all(taskId) as { task_id: string; field: string; source_text: string; vector_blob: Buffer; dimensions: number; model: string; created_at: string }[];

  return rows.map((row) => {
    const float32 = new Float32Array(row.vector_blob.buffer, row.vector_blob.byteOffset, row.dimensions);
    return {
      task_id: row.task_id,
      field: row.field as VectorRecord["field"],
      source_text: row.source_text,
      vector: Array.from(float32),
      dimensions: row.dimensions,
      model: row.model,
      created_at: row.created_at
    };
  });
}

// ---------------------------------------------------------------------------
// Combined task upsert (frontmatter + body + index)
// ---------------------------------------------------------------------------

/**
 * Full task upsert: writes frontmatter, body to per-task tables,
 * and updates the global task_index.
 */
export function upsertTaskSnapshot(task: TaskDocument, taskPath: string, syncedAt = new Date().toISOString()): void {
  const taskId = task.frontmatter.task_id;

  const txn = db.transaction(() => {
    upsertTaskFrontmatter(task);
    upsertTaskBody(task);

    // Update global index
    db.prepare(`
      INSERT INTO task_index (task_id, status, hidden, interaction_type, version, updated_at, task_path, synced_at)
      VALUES (@task_id, @status, @hidden, @interaction_type, @version, @updated_at, @task_path, @synced_at)
      ON CONFLICT(task_id) DO UPDATE SET
        status = excluded.status,
        hidden = excluded.hidden,
        interaction_type = excluded.interaction_type,
        version = excluded.version,
        updated_at = excluded.updated_at,
        task_path = excluded.task_path,
        synced_at = excluded.synced_at
    `).run({
      task_id: taskId,
      status: task.frontmatter.status,
      hidden: task.frontmatter.hidden ? 1 : 0,
      interaction_type: task.frontmatter.interaction_type,
      version: task.frontmatter.version,
      updated_at: task.frontmatter.updated_at,
      task_path: taskPath,
      synced_at: syncedAt
    });
  });

  txn();
}

// ---------------------------------------------------------------------------
// Read helpers (backward-compatible)
// ---------------------------------------------------------------------------

export interface SqliteTaskIndexRow {
  task_id: string;
  status: string;
  hidden: number;
  interaction_type: string;
  version: number;
  updated_at: string;
  task_path: string;
  synced_at: string;
}

export function listTaskSnapshots(): SqliteTaskIndexRow[] {
  return db.prepare(`
    SELECT task_id, status, hidden, interaction_type, version, updated_at, task_path, synced_at
    FROM task_index ORDER BY updated_at DESC
  `).all() as SqliteTaskIndexRow[];
}

export function readTaskSnapshot(taskId: string): SqliteTaskIndexRow | null {
  const row = db.prepare(`
    SELECT task_id, status, hidden, interaction_type, version, updated_at, task_path, synced_at
    FROM task_index WHERE task_id = ? LIMIT 1
  `).get(taskId) as SqliteTaskIndexRow | undefined;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// L0 query helper: filter by interaction_type at DB level
// ---------------------------------------------------------------------------

/**
 * Find candidate task_ids that are compatible with the given interaction_type.
 * Only returns tasks in "Searching" status, excluding the source task.
 */
export function queryL0CandidatesFromDb(
  sourceTaskId: string,
  sourceInteractionType: string
): string[] {
  let rows: { task_id: string }[];

  if (sourceInteractionType === "any") {
    rows = db.prepare(`
      SELECT task_id FROM task_index
      WHERE task_id != ? AND status = 'Searching'
    `).all(sourceTaskId) as { task_id: string }[];
  } else {
    rows = db.prepare(`
      SELECT task_id FROM task_index
      WHERE task_id != ? AND status = 'Searching'
        AND (interaction_type = ? OR interaction_type = 'any')
    `).all(sourceTaskId, sourceInteractionType) as { task_id: string }[];
  }

  return rows.map((r) => r.task_id);
}

// ---------------------------------------------------------------------------
// Health / diagnostics
// ---------------------------------------------------------------------------

export function sqliteHealth(): { dbPath: string; taskCount: number } {
  const row = db.prepare("SELECT COUNT(*) as count FROM task_index").get() as { count: number };
  return {
    dbPath: SQLITE_DB_PATH,
    taskCount: row.count
  };
}

/**
 * Get the raw database handle for advanced operations (e.g., tests).
 */
export function getDb(): DatabaseType {
  return db;
}
