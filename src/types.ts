// Shared types used across the backend and serialized to the frontend.

/** Event categories, derived from the source log file. */
export type Category =
  | "map" // object placement / removal / interaction (_map.txt)
  | "cmd" // commands: campfire, stove, etc. (_cmd.txt)
  | "pvp" // player-vs-player combat (_pvp.txt)
  | "vehicle" // vehicle attach/enter/exit (_vehicle.txt)
  | "player" // connect/level/death/tick (_player.txt)
  | "admin" // admin actions (_admin.txt)
  | "safehouse" // safehouse claim/release (_safehouse.txt)
  | "other"; // anything else with coordinates

/** A single normalized log event. Coordinates are in game world tiles. */
export interface GameEvent {
  /** Epoch milliseconds parsed from the `[DD-MM-YY HH:MM:SS.sss]` stamp. */
  ts: number;
  category: Category;
  /** Short verb/action token, e.g. "taken", "light", "hit", "death". */
  action: string;
  player: string | null;
  steamid: string | null;
  /** World tile coordinates. Null when the line carries no position. */
  x: number | null;
  y: number | null;
  z: number | null;
  /** Rich per-player metrics, only present on `_player.txt` connect/tick lines. */
  details?: PlayerDetails;
}

/** Metrics carried by `_player.txt` connect/tick lines (perks, stats, health). */
export interface PlayerDetails {
  profession: string | null;
  kills: number | null;
  /** Survived in-game hours. */
  hours: number | null;
  /** 0–100 body health. */
  health: number | null;
  infected: boolean | null;
  /** Skill -> level map, e.g. { Axe: 5, Strength: 10 }. */
  perks: Record<string, number> | null;
  traits: string[] | null;
}

/** A tracked player's latest known position + metrics, served to the frontend. */
export interface PlayerInfo extends PlayerDetails {
  steamid: string;
  name: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
  /** True when the player is connected (last action wasn't a disconnect) and
   *  has been seen recently relative to the newest tick. */
  online: boolean;
  /** The last log action seen for this player (connected/tick/disconnected/…). */
  lastAction: string;
  /** Epoch ms of first and most recent log line mentioning this player. */
  firstSeen: number;
  lastSeen: number;
}

/** A single player death location, in game world tile coordinates. */
export interface DeathInfo {
  steamid: string;
  name: string | null;
  x: number;
  y: number;
  z: number | null;
  /** Epoch ms of the death. */
  ts: number;
  /** In-game hours survived before this death, when the log records it. */
  hours: number | null;
}

/** A weighted point for the heatmap, in game world tile coordinates. */
export interface HeatPoint {
  x: number;
  y: number;
  weight: number;
}

/** Aggregated heatmap data: weighted points keyed by category, plus the
 *  per-point day bucket arrays used for time-range filtering. */
export interface HeatmapData {
  /** Inclusive epoch-ms bounds of all events seen. */
  from: number;
  to: number;
  /** Bin size in tiles used for aggregation. */
  binSize: number;
  /** Per-category list of bins. */
  categories: Record<string, HeatBin[]>;
}

/** One aggregation bin: a grid cell with a per-day-bucket weight breakdown. */
export interface HeatBin {
  x: number;
  y: number;
  /** Total weight across all time. */
  weight: number;
  /** Weight per day bucket: { "2026-05-27": 3, ... }. Enables time filtering. */
  byDay: Record<string, number>;
}

/**
 * How a game tile coordinate (x, y) maps to a pixel in the map image.
 *
 * - `iso`: the community map (map.projectzomboid.com) is isometric. This mirrors
 *   its tileToPixel transform: with a = (x - offsetX), b = (y - offsetY),
 *     px = (a - b) * 32 * multiply + originX
 *     py = (a + b) * 16 * multiply + originY
 *   (offset = extra.json PxToTileOffset, origin = TileToPxOffset.)
 * - `ortho`: a top-down render (e.g. pzmap2dzi `*_top`), a simple linear scale:
 *     px = x * pixelsPerTile, py = y * pixelsPerTile.
 */
export type Projection =
  | {
      mode: "iso";
      multiply: number;
      offsetX: number;
      offsetY: number;
      originX: number;
      originY: number;
    }
  | { mode: "ortho"; pixelsPerTile: number };

/** Map metadata served to the frontend so it can build the projection. */
export interface MapMeta {
  build: number;
  /** Full-resolution image dimensions of the proxied DZI render (px). */
  imageWidth: number;
  imageHeight: number;
  /** DZI tile size, overlap and max (full-res) level. */
  tileSize: number;
  overlap: number;
  maxLevel: number;
  format: string;
  /** Leaflet tile URL template (through our /tiles proxy) with {z}/{x}/{y}. */
  tileUrlTemplate: string;
  /** Game-tile -> image-pixel transform. */
  projection: Projection;
  /** Categories that actually have data, with their event counts. */
  available: Record<string, number>;
  /** Epoch-ms range of observed events (for the time slider); null when empty. */
  eventsFrom: number | null;
  eventsTo: number | null;
  lastUpdated: number;
}
