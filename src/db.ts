import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Open the SQLite DB for read/write, self-healing a stale read-only file.
 *
 * If the db was created by a different user (e.g. running `bun run backfill` as
 * root while the service runs as another user), the service can read but not
 * write it and every write throws SQLITE_READONLY — crash-looping the service.
 * Since the *data directory* is writable, we can delete the unwritable file and
 * recreate it; a backfill repopulates the history (player table, offsets, and
 * the heatmap aggregate now all live in this one file). If the directory itself
 * is read-only, the recreate fails too and we surface the original error.
 */
export function openDb(dbPath: string): Database {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  // Default rollback journal (no WAL) — single process, and it avoids stray
  // -wal/-shm files that compound cross-user permission problems.
  const db = new Database(dbPath);
  if (dbPath === ":memory:") return db;
  try {
    writeProbe(db);
    return db;
  } catch (err) {
    if ((err as { code?: string }).code !== "SQLITE_READONLY") throw err;
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        rmSync(dbPath + suffix);
      } catch {
        /* file may not exist */
      }
    }
    console.warn(
      `database was read-only (likely created by another user, e.g. ` +
        `\`bun run backfill\` as root) — recreated it. Re-run backfill to restore history.`,
    );
    const fresh = new Database(dbPath);
    writeProbe(fresh); // if this still fails the data dir itself is read-only
    return fresh;
  }
}

/**
 * Probe write access without leaving any schema artifact: rewrite user_version
 * to its own value. Throws SQLITE_READONLY if the file isn't writable.
 */
function writeProbe(db: Database): void {
  const v = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  db.run(`PRAGMA user_version = ${v}`);
}
