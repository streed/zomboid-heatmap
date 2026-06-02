import { resolve } from "node:path";
import { getBuildPreset, type ProjectionMode } from "./builds.ts";

// Centralized, validated configuration loaded from the environment. Bun loads
// `.env` automatically, so no dotenv dependency is needed.

/**
 * Read an env var and clean it up. systemd's `EnvironmentFile` keeps inline
 * `# comments` literally (it only honors whole-line comments), so a value like
 * `REFRESH_MINUTES=1   # the timer` would otherwise arrive as the whole string.
 * We trim, strip an unquoted trailing ` # comment`, and unwrap matching quotes.
 */
function envValue(name: string): string | undefined {
  let v = process.env[name];
  if (v === undefined) return undefined;
  v = v.trim().replace(/\s+#.*$/, "").trim();
  const quoted = /^(["'])(.*)\1$/.exec(v);
  if (quoted) v = quoted[2]!;
  return v;
}

function num(name: string, fallback: number): number {
  const raw = envValue(name);
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

function str(name: string, fallback: string): string {
  const raw = envValue(name);
  return raw === undefined || raw === "" ? fallback : raw;
}

const build = num("BUILD", 41);
const preset = getBuildPreset(build);

const dataDir = resolve(str("DATA_DIR", "./data"));
const projection = str("PROJECTION", preset.projection) as ProjectionMode;

export const config = {
  build,
  /** Absolute path to the server's `Zomboid/Logs` directory. */
  logsDir: resolve(str("LOGS_DIR", "./logs")),

  /** Upstream community map (host base) + which map folder under `maps/`. */
  tileUpstream: str("TILE_UPSTREAM", preset.tileUpstream).replace(/\/?$/, "/"),
  mapDesc: str("MAP_DESC", preset.mapDesc),
  descriptor: str("MAP_DESCRIPTOR", preset.descriptor),

  /** Coordinate projection: "iso" (community map) or "ortho" (top-down render). */
  projection,
  /** Only used by the ortho projection: world width in tiles -> pixelsPerTile. */
  worldTilesX: num("WORLD_TILES_X", preset.worldTilesX),

  /** How often (minutes) to re-scan logs and recompute the aggregate. */
  refreshMinutes: num("REFRESH_MINUTES", 5),
  /** Grid bin size in tiles for aggregation. Larger = coarser + smaller payload. */
  binSize: num("BIN_SIZE", 10),

  /** Bind address. Set to "127.0.0.1" when behind a reverse proxy (recommended). */
  hostname: str("HOSTNAME", "0.0.0.0"),
  port: num("PORT", 8080),
  /** CSP `frame-ancestors` value controlling who may embed the iframe. */
  frameAncestors: str("FRAME_ANCESTORS", "*"),

  dataDir,
  cacheDir: resolve(dataDir, "cache", "tiles"),
  stateFile: resolve(dataDir, "state.json"),
  /** SQLite database holding per-player metrics + latest known position. */
  dbFile: resolve(dataDir, "players.db"),

  /** A player drops off the live map this long (wall-clock) after their last
   *  log line, even without an explicit disconnect. Assumes log timestamps are
   *  roughly in sync with the host clock (run the PZ server in UTC). */
  playerStaleMs: num("PLAYER_STALE_MINUTES", 30) * 60_000,
} as const;

export type Config = typeof config;
