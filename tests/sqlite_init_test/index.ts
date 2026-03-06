import path from "node:path";
import Database from "better-sqlite3";

const DB_PATH = path.resolve(process.cwd(), ".data/task_agent.db");
const db = new Database(DB_PATH);

// 1. List all tables
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all() as { name: string }[];

console.log(`\n=== task_agent.db tables (${tables.length}) ===`);
for (const t of tables) {
  const count = (db.prepare(`SELECT COUNT(*) as c FROM "${t.name}"`).get() as { c: number }).c;
  console.log(`  ${t.name} : ${count} rows`);
}

// 2. Drop all tables (clean slate)
console.log("\n=== Dropping all tables ===");
const dropTxn = db.transaction(() => {
  for (const t of tables) {
    db.exec(`DROP TABLE IF EXISTS "${t.name}"`);
    console.log(`  dropped: ${t.name}`);
  }
});
dropTxn();

// 3. Verify empty
const remaining = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table'")
  .all() as { name: string }[];
console.log(`\n=== Done. Remaining tables: ${remaining.length} ===`);

// 4. VACUUM to reclaim disk space
db.exec("VACUUM");
console.log("VACUUM complete.\n");

db.close();
