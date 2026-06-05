import type { Database } from "bun:sqlite";
import { openDb } from "./db.ts";
import type { DeathInfo, GameEvent, HeatPoint, PlayerInfo, PlayerPath } from "./types.ts";

/** UTC day key "YYYY-MM-DD" — matches the Aggregator's bucketing. */
function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** One day in milliseconds — the default window for the all-players path view. */
const DAY_MS = 24 * 60 * 60_000;

/**
 * Tracks each player's latest known position + metrics, and a per-player binned
 * position history for the "filter by player" heatmap — all persisted in SQLite.
 *
 * The heatmap {@link Aggregator} deliberately collapses individuals into
 * anonymous bins; that's the wrong shape for "where is each player" and "where
 * has one player been". This keeps:
 *   - `players`        : one row per steamid (latest position + metrics)
 *   - `player_points`  : per-player binned position counts (category + day)
 *   - `player_positions`: raw timestamped positions, for movement paths/trails
 *
 * Metric updates are idempotent and order-insensitive (a row only moves forward
 * for an event at least as recent as what's stored). Point counts are additive,
 * exactly like the aggregator: incremental scans only see each event once
 * (offsets guarantee it), and a full rebuild calls {@link reset} first so a
 * re-scan doesn't double-count.
 */
export class PlayerTracker {
  private readonly db: Database;
  private readonly upsertPlayer;
  private readonly upsertPoint;
  private readonly insertPosition;
  private readonly insertDeath;
  private readonly getKills;

  constructor(
    /** A shared {@link Database} (preferred — see index.ts) or a path to open. */
    db: Database | string,
    /** Staleness window: online players must have been seen within this long of
     *  the current (wall-clock) time. */
    private readonly staleMs = 30 * 60_000,
    /** Tile bin size for the per-player heatmap (mirrors the aggregator). */
    private readonly binSize = 10,
  ) {
    this.db = typeof db === "string" ? openDb(db) : db;
    this.db.run(`
      CREATE TABLE IF NOT EXISTS players (
        steamid     TEXT PRIMARY KEY,
        name        TEXT,
        x           INTEGER,
        y           INTEGER,
        z           INTEGER,
        online      INTEGER NOT NULL DEFAULT 0,
        last_action TEXT,
        profession  TEXT,
        kills       INTEGER,
        kills_life  INTEGER,
        hours       REAL,
        health      INTEGER,
        infected    INTEGER,
        perks       TEXT,
        traits      TEXT,
        first_seen  INTEGER NOT NULL,
        last_seen   INTEGER NOT NULL
      )
    `);
    // Migrate older DBs that predate cumulative-kills tracking. `kills` holds the
    // running total across lives; `kills_life` the current character's last
    // reported count (used to detect respawn resets).
    try {
      this.db.run("ALTER TABLE players ADD COLUMN kills_life INTEGER");
    } catch {
      /* column already exists */
    }
    this.db.run(`
      CREATE TABLE IF NOT EXISTS player_points (
        steamid  TEXT NOT NULL,
        category TEXT NOT NULL,
        bin_x    INTEGER NOT NULL,
        bin_y    INTEGER NOT NULL,
        day      TEXT NOT NULL,
        weight   INTEGER NOT NULL,
        PRIMARY KEY (steamid, category, bin_x, bin_y, day)
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS player_deaths (
        steamid TEXT NOT NULL,
        name    TEXT,
        x       INTEGER NOT NULL,
        y       INTEGER NOT NULL,
        z       INTEGER,
        ts      INTEGER NOT NULL,
        hours   REAL,
        PRIMARY KEY (steamid, ts)
      )
    `);
    // Raw, timestamped positions kept in arrival order so we can draw each
    // player's movement trail (the binned `player_points` deliberately discards
    // ordering and exact coordinates). Keyed by (steamid, ts) so re-scanning a
    // log — e.g. a backfill — is idempotent. Unlike the binned tables this is
    // independent of binSize, so it survives a BIN_SIZE change untouched.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS player_positions (
        steamid TEXT NOT NULL,
        ts      INTEGER NOT NULL,
        x       INTEGER NOT NULL,
        y       INTEGER NOT NULL,
        z       INTEGER,
        PRIMARY KEY (steamid, ts)
      )
    `);
    // Index the all-players "past day" path query (latest-N positions by time).
    this.db.run("CREATE INDEX IF NOT EXISTS idx_positions_ts ON player_positions (ts)");

    // The binned points are tied to binSize; if it changed since last run the
    // old bins are incompatible, so drop them (a re-scan/backfill repopulates).
    // user_version is a cheap per-DB integer slot, perfect for this.
    const storedBin = (this.db.query("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    if (storedBin !== binSize) {
      this.db.run("DELETE FROM player_points");
      this.db.run(`PRAGMA user_version = ${Math.trunc(binSize)}`);
    }

    this.upsertPlayer = this.db.query(`
      INSERT INTO players (
        steamid, name, x, y, z, online, last_action,
        profession, kills, kills_life, hours, health, infected, perks, traits,
        first_seen, last_seen
      ) VALUES (
        $steamid, $name, $x, $y, $z, $online, $action,
        $profession, $kills, $kills_life, $hours, $health, $infected, $perks, $traits,
        $ts, $ts
      )
      ON CONFLICT(steamid) DO UPDATE SET
        name        = COALESCE(excluded.name, players.name),
        x           = excluded.x,
        y           = excluded.y,
        z           = excluded.z,
        online      = excluded.online,
        last_action = excluded.last_action,
        profession  = COALESCE(excluded.profession, players.profession),
        kills       = COALESCE(excluded.kills,      players.kills),
        kills_life  = COALESCE(excluded.kills_life, players.kills_life),
        hours       = COALESCE(excluded.hours,      players.hours),
        health      = COALESCE(excluded.health,     players.health),
        infected    = COALESCE(excluded.infected,   players.infected),
        perks       = COALESCE(excluded.perks,      players.perks),
        traits      = COALESCE(excluded.traits,     players.traits),
        last_seen   = excluded.last_seen
      WHERE excluded.last_seen >= players.last_seen
    `);

    // Read current kill counters to fold a new report into the running total.
    this.getKills = this.db.query(
      "SELECT kills, kills_life FROM players WHERE steamid = $steamid",
    );

    this.upsertPoint = this.db.query(`
      INSERT INTO player_points (steamid, category, bin_x, bin_y, day, weight)
      VALUES ($steamid, $category, $bx, $by, $day, 1)
      ON CONFLICT(steamid, category, bin_x, bin_y, day)
      DO UPDATE SET weight = weight + 1
    `);

    // One position sample per (steamid, ts); a re-scan re-applies the same rows
    // harmlessly. We keep the first seen for a given timestamp.
    this.insertPosition = this.db.query(`
      INSERT OR IGNORE INTO player_positions (steamid, ts, x, y, z)
      VALUES ($steamid, $ts, $x, $y, $z)
    `);

    // Deaths are discrete events keyed by (steamid, ts), so re-scanning the same
    // log (e.g. a backfill) is idempotent — the duplicate is ignored.
    this.insertDeath = this.db.query(`
      INSERT OR IGNORE INTO player_deaths (steamid, name, x, y, z, ts, hours)
      VALUES ($steamid, $name, $x, $y, $z, $ts, $hours)
    `);
  }

  /** Upsert latest state + accumulate binned positions from a scan's events. */
  update(events: GameEvent[]): void {
    const tx = this.db.transaction((rows: GameEvent[]) => {
      for (const e of rows) {
        if (!e.steamid) continue;

        // Latest position + metrics — player logs only.
        if (e.category === "player") {
          const d = e.details;

          // Cumulative kills: the game resets a character's kill count to 0 on
          // death/respawn, so we sum the increments across lives. A reported
          // value below the current life's last count means a new character —
          // count it from zero rather than treating the drop as negative.
          let cumulative: number | null = null;
          let killsLife: number | null = null;
          if (d && typeof d.kills === "number") {
            const prev = this.getKills.get({ $steamid: e.steamid }) as
              | { kills: number | null; kills_life: number | null }
              | null;
            const prevTotal = prev?.kills ?? 0;
            const prevLife = prev?.kills_life ?? 0;
            const delta = d.kills >= prevLife ? d.kills - prevLife : d.kills;
            cumulative = prevTotal + delta;
            killsLife = d.kills;
          }

          this.upsertPlayer.run({
            $steamid: e.steamid,
            $name: e.player,
            $x: e.x,
            $y: e.y,
            $z: e.z,
            $online: e.action === "disconnected" ? 0 : 1,
            $action: e.action,
            $profession: d?.profession ?? null,
            $kills: cumulative,
            $kills_life: killsLife,
            $hours: d?.hours ?? null,
            $health: d?.health ?? null,
            $infected: d?.infected == null ? null : d.infected ? 1 : 0,
            $perks: d?.perks ? JSON.stringify(d.perks) : null,
            $traits: d?.traits ? JSON.stringify(d.traits) : null,
            $ts: e.ts,
          });

          // Record the raw position over time so we can draw movement trails.
          // Sourced from the player log only (its connect/tick lines are
          // periodic position samples) — action logs would muddy the path.
          if (e.x !== null && e.y !== null) {
            this.insertPosition.run({
              $steamid: e.steamid,
              $ts: e.ts,
              $x: e.x,
              $y: e.y,
              $z: e.z,
            });
          }
        }

        // Per-player binned activity across all categories (for filtering).
        if (e.x !== null && e.y !== null) {
          this.upsertPoint.run({
            $steamid: e.steamid,
            $category: e.category,
            $bx: Math.floor(e.x / this.binSize),
            $by: Math.floor(e.y / this.binSize),
            $day: dayKey(e.ts),
          });
        }

        // Discrete death locations (for per-player death markers).
        if (e.action === "died" && e.x !== null && e.y !== null) {
          this.insertDeath.run({
            $steamid: e.steamid,
            $name: e.player,
            $x: e.x,
            $y: e.y,
            $z: e.z,
            $ts: e.ts,
            $hours: e.details?.hours ?? null,
          });
        }
      }
    });
    tx(events);
  }

  /** Wipe all tracked data (used on a full rebuild, before re-scanning). */
  reset(): void {
    this.db.run("DELETE FROM players");
    this.db.run("DELETE FROM player_points");
    this.db.run("DELETE FROM player_positions");
    this.db.run("DELETE FROM player_deaths");
  }

  /**
   * Current players. `onlineOnly` keeps just those whose last action wasn't a
   * disconnect and who were seen within {@link staleMs} of `now` (wall-clock by
   * default; injectable for tests).
   */
  list(opts: { onlineOnly?: boolean; now?: number } = {}): PlayerInfo[] {
    const now = opts.now ?? Date.now();
    const rows = this.db.query("SELECT * FROM players").all() as PlayerRow[];
    const all = rows.map((r) => this.toInfo(r, now));
    return opts.onlineOnly ? all.filter((p) => p.online) : all;
  }

  /**
   * Weighted heatmap points for one player, optionally restricted to a set of
   * categories and an inclusive [from, to] epoch-ms range. Same bin-center
   * output shape as {@link Aggregator.query}, so the frontend renders it the
   * same way.
   */
  heatmap(
    steamid: string,
    opts: { categories?: string[]; from?: number; to?: number } = {},
  ): HeatPoint[] {
    const params: Record<string, string> = { $steamid: steamid };
    let sql =
      "SELECT bin_x, bin_y, SUM(weight) AS w FROM player_points WHERE steamid = $steamid";

    if (opts.categories && opts.categories.length) {
      const ph = opts.categories.map((_, i) => `$c${i}`);
      opts.categories.forEach((c, i) => (params[`$c${i}`] = c));
      sql += ` AND category IN (${ph.join(",")})`;
    }
    if (opts.from !== undefined) {
      params.$fromDay = dayKey(opts.from);
      sql += " AND day >= $fromDay";
    }
    if (opts.to !== undefined) {
      params.$toDay = dayKey(opts.to);
      sql += " AND day <= $toDay";
    }
    sql += " GROUP BY bin_x, bin_y";

    const half = this.binSize / 2;
    return (this.db.query(sql).all(params) as { bin_x: number; bin_y: number; w: number }[]).map(
      (r) => ({ x: r.bin_x * this.binSize + half, y: r.bin_y * this.binSize + half, weight: r.w }),
    );
  }

  /**
   * Ordered movement trails (oldest → newest position per player).
   *
   * - With `player` (steamid): that player's *entire* recorded history.
   * - Without: every player's positions, restricted to the **past day** — by
   *   default the 24h leading up to the most recent recorded position (so it
   *   degrades gracefully on historical/example logs as well as live servers).
   *
   * An explicit `from`/`to` (inclusive epoch-ms) overrides the default window.
   */
  paths(opts: { player?: string; from?: number; to?: number } = {}): PlayerPath[] {
    const params: Record<string, string | number> = {};
    const where: string[] = [];
    if (opts.player) {
      where.push("pp.steamid = $player");
      params.$player = opts.player;
    }

    let from = opts.from;
    const to = opts.to;
    // All-players view defaults to the past day; a single player gets it all.
    if (!opts.player && from === undefined && to === undefined) {
      const latest = (
        this.db.query("SELECT MAX(ts) AS m FROM player_positions").get() as { m: number | null }
      ).m;
      if (latest !== null) from = latest - DAY_MS;
    }
    if (from !== undefined) {
      where.push("pp.ts >= $from");
      params.$from = from;
    }
    if (to !== undefined) {
      where.push("pp.ts <= $to");
      params.$to = to;
    }

    const sql =
      "SELECT pp.steamid AS steamid, p.name AS name, pp.ts AS ts, pp.x AS x, pp.y AS y " +
      "FROM player_positions pp LEFT JOIN players p ON p.steamid = pp.steamid" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY pp.steamid, pp.ts";

    const rows = this.db.query(sql).all(params) as {
      steamid: string;
      name: string | null;
      ts: number;
      x: number;
      y: number;
    }[];

    // Group the flat, steamid-then-ts ordered rows into one trail per player.
    const paths: PlayerPath[] = [];
    let current: PlayerPath | null = null;
    for (const r of rows) {
      if (!current || current.steamid !== r.steamid) {
        current = { steamid: r.steamid, name: r.name, points: [] };
        paths.push(current);
      }
      current.points.push({ ts: r.ts, x: r.x, y: r.y });
    }
    return paths;
  }

  /**
   * Death locations, optionally for one player and/or an inclusive [from, to]
   * epoch-ms range, newest first.
   */
  deaths(opts: { player?: string; from?: number; to?: number } = {}): DeathInfo[] {
    const params: Record<string, string | number> = {};
    const where: string[] = [];
    if (opts.player) {
      where.push("steamid = $player");
      params.$player = opts.player;
    }
    if (opts.from !== undefined) {
      where.push("ts >= $from");
      params.$from = opts.from;
    }
    if (opts.to !== undefined) {
      where.push("ts <= $to");
      params.$to = opts.to;
    }
    const sql =
      "SELECT steamid, name, x, y, z, ts, hours FROM player_deaths" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY ts DESC";
    return this.db.query(sql).all(params) as DeathInfo[];
  }

  /** Total number of tracked players. */
  count(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM players").get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }

  private toInfo(r: PlayerRow, now: number): PlayerInfo {
    return {
      steamid: r.steamid,
      name: r.name,
      x: r.x,
      y: r.y,
      z: r.z,
      online: r.online === 1 && r.last_seen >= now - this.staleMs,
      lastAction: r.last_action ?? "",
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      profession: r.profession,
      kills: r.kills,
      hours: r.hours,
      health: r.health,
      infected: r.infected == null ? null : r.infected === 1,
      perks: parseJson<Record<string, number>>(r.perks),
      traits: parseJson<string[]>(r.traits),
    };
  }
}

interface PlayerRow {
  steamid: string;
  name: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
  online: number;
  last_action: string | null;
  profession: string | null;
  kills: number | null;
  hours: number | null;
  health: number | null;
  infected: number | null;
  perks: string | null;
  traits: string | null;
  first_seen: number;
  last_seen: number;
}

function parseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
