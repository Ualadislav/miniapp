import Database from "better-sqlite3";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const databasePath = resolve(process.env.DATABASE_PATH ?? "./data/habits.sqlite");
const backupDirectory = resolve(process.env.BACKUP_DIR ?? "./backups");
const retentionDays = 7;

await mkdir(backupDirectory, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = join(backupDirectory, `habits-${timestamp}.sqlite`);
const database = new Database(databasePath, { readonly: true });

try {
  await database.backup(backupPath);
} finally {
  database.close();
}

const retentionThreshold = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
const entries = await readdir(backupDirectory);
for (const entry of entries) {
  if (!/^habits-\d{4}-\d{2}-\d{2}T.*\.sqlite$/.test(basename(entry))) continue;
  const path = join(backupDirectory, entry);
  if ((await stat(path)).mtimeMs < retentionThreshold) await unlink(path);
}

console.log(`Database backup created: ${backupPath}`);
