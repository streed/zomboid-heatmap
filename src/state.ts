import type { Database } from "bun:sqlite";
import type { FileOffsets } from "./parser/scan.ts";
import type { HeatBin, HeatmapData } from "./types.ts";

/**
 * Persists the scan state that used to live in `state.json` — file offsets, the
 * heatmap aggregate, per-category counts, and `lastUpdated` — in the same
 * SQLite DB that backs {@link PlayerTracker}. One file, one persistence layer.
 *
 * The {@link Aggregator} stays in-memory for fast queries; this store just
 * serializes it (and the scan offsets) on each refresh and restores it on
 * startup, the same role `state.json` played. The aggregate's `byDay` breakdown
 * normalizes into one row per (category, bin, day), mirroring `player_points`.
 *
 * Tables:
 *   - `scan_offsets`     : byte offset already consumed, per absolute log path
 *   - `heat_points`      : category -> bin -> day weight (the aggregate)
 *   - `category_counts`  : total events per category (incl. coordinate-less)
 *   - `heat_meta`        : key/value slots for bin_size, last_updated, range
 */
export class StateStore {
  private readonly db: Database;
  private readonly half: number;
  private readonly insertOffset;
  private readonly insertPoint;
  private readonly insertCount;
  private readonly setMetaStmt;

  constructor(db: Database, private readonly binSize: number) {
    this.db = db;
    this.half = binSize / 2;
    this.db.run(`
      CREATE TABLE IF NOT EXISTS scan_offsets (
        path        TEXT PRIMARY KEY,
        byte_offset INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS heat_points (
        category TEXT NOT NULL,
        bin_x    INTEGER NOT NULL,
        bin_y    INTEGER NOT NULL,
        day      TEXT NOT NULL,
        weight   INTEGER NOT NULL,
        PRIMARY KEY (category, bin_x, bin_y, day)
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS category_counts (
        category TEXT PRIMARY KEY,
        count    INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS heat_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    this.setMetaStmt = this.db.query(
      "INSERT INTO heat_meta (key, value) VALUES ($k, $v) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );

    // Bins are keyed to binSize; if it changed since last run the stored bins
    // and offsets are incompatible — drop them so a re-scan rebuilds from zero.
    const stored = this.getMeta("bin_size");
    if (stored !== null && Number(stored) !== binSize) {
      this.db.run("DELETE FROM scan_offsets");
      this.db.run("DELETE FROM heat_points");
      this.db.run("DELETE FROM category_counts");
    }
    this.setMeta("bin_size", String(binSize));

    this.insertOffset = this.db.query(
      "INSERT INTO scan_offsets (path, byte_offset) VALUES ($path, $offset)",
    );
    this.insertPoint = this.db.query(
      "INSERT INTO heat_points (category, bin_x, bin_y, day, weight) " +
        "VALUES ($category, $bx, $by, $day, $weight)",
    );
    this.insertCount = this.db.query(
      "INSERT INTO category_counts (category, count) VALUES ($category, $count)",
    );
  }

  /** Byte offsets already consumed, keyed by absolute log path. */
  loadOffsets(): FileOffsets {
    const rows = this.db
      .query("SELECT path, byte_offset FROM scan_offsets")
      .all() as { path: string; byte_offset: number }[];
    const offsets: FileOffsets = {};
    for (const r of rows) offsets[r.path] = r.byte_offset;
    return offsets;
  }

  /** Restore the serialized aggregate + counts (shape consumed by Aggregator.load). */
  loadAggregate(): { data: HeatmapData; counts: Record<string, number> } {
    const rows = this.db
      .query("SELECT category, bin_x, bin_y, day, weight FROM heat_points")
      .all() as { category: string; bin_x: number; bin_y: number; day: string; weight: number }[];

    const categories: Record<string, HeatBin[]> = {};
    // Rebuild one HeatBin per (category, bin), folding the per-day rows back in.
    const byBin = new Map<string, HeatBin>();
    for (const r of rows) {
      const key = `${r.category},${r.bin_x},${r.bin_y}`;
      let bin = byBin.get(key);
      if (!bin) {
        bin = {
          x: r.bin_x * this.binSize + this.half,
          y: r.bin_y * this.binSize + this.half,
          weight: 0,
          byDay: {},
        };
        byBin.set(key, bin);
        (categories[r.category] ??= []).push(bin);
      }
      bin.weight += r.weight;
      bin.byDay[r.day] = (bin.byDay[r.day] ?? 0) + r.weight;
    }

    const counts: Record<string, number> = {};
    for (const r of this.db.query("SELECT category, count FROM category_counts").all() as {
      category: string;
      count: number;
    }[]) {
      counts[r.category] = r.count;
    }

    return {
      data: {
        from: Number(this.getMeta("event_from") ?? 0),
        to: Number(this.getMeta("event_to") ?? 0),
        binSize: this.binSize,
        categories,
      },
      counts,
    };
  }

  /** Epoch-ms of the last successful scan (0 if never). */
  lastUpdated(): number {
    return Number(this.getMeta("last_updated") ?? 0);
  }

  /** Atomically replace the full persisted state (offsets + aggregate + meta). */
  save(
    offsets: FileOffsets,
    aggregate: HeatmapData,
    counts: Record<string, number>,
    lastUpdated: number,
  ): void {
    const tx = this.db.transaction(() => {
      this.db.run("DELETE FROM scan_offsets");
      for (const [path, offset] of Object.entries(offsets)) {
        this.insertOffset.run({ $path: path, $offset: offset });
      }

      this.db.run("DELETE FROM heat_points");
      for (const [category, bins] of Object.entries(aggregate.categories)) {
        for (const bin of bins) {
          const bx = Math.floor(bin.x / this.binSize);
          const by = Math.floor(bin.y / this.binSize);
          for (const [day, weight] of Object.entries(bin.byDay)) {
            this.insertPoint.run({ $category: category, $bx: bx, $by: by, $day: day, $weight: weight });
          }
        }
      }

      this.db.run("DELETE FROM category_counts");
      for (const [category, count] of Object.entries(counts)) {
        this.insertCount.run({ $category: category, $count: count });
      }

      this.setMeta("event_from", String(aggregate.from));
      this.setMeta("event_to", String(aggregate.to));
      this.setMeta("last_updated", String(lastUpdated));
    });
    tx();
  }

  /** Wipe all persisted scan state (used by `--backfill` before a full re-scan). */
  reset(): void {
    this.db.run("DELETE FROM scan_offsets");
    this.db.run("DELETE FROM heat_points");
    this.db.run("DELETE FROM category_counts");
    this.db.run("DELETE FROM heat_meta");
    this.setMeta("bin_size", String(this.binSize));
  }

  private getMeta(key: string): string | null {
    const row = this.db.query("SELECT value FROM heat_meta WHERE key = $k").get({ $k: key }) as
      | { value: string }
      | null;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.setMetaStmt.run({ $k: key, $v: value });
  }
}
