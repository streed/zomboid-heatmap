import { resolve } from "node:path";
import { getBuildPreset, type ProjectionMode } from "./builds.ts";

// Centralized, validated configuration loaded from the environment. Bun loads
// `.env` automatically, so no dotenv dependency is needed.

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
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

  port: num("PORT", 8080),
  /** CSP `frame-ancestors` value controlling who may embed the iframe. */
  frameAncestors: str("FRAME_ANCESTORS", "*"),

  dataDir,
  cacheDir: resolve(dataDir, "cache", "tiles"),
  stateFile: resolve(dataDir, "state.json"),
} as const;

export type Config = typeof config;
