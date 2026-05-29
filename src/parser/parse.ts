import type { Category, GameEvent } from "../types.ts";
import { ACTOR_RE, COORD_RE, PVP_RE, TS_RE } from "./patterns.ts";

/** Convert a parsed `[DD-MM-YY HH:MM:SS.sss]` stamp to epoch milliseconds.
 *  Logs carry no timezone, so we interpret consistently as UTC — fine for
 *  relative ordering and day bucketing. */
function toEpoch(m: RegExpExecArray): number {
  const dd = +m[1]!,
    mm = +m[2]!,
    yy = +m[3]!,
    hh = +m[4]!,
    min = +m[5]!,
    ss = +m[6]!,
    ms = +m[7]!;
  return Date.UTC(2000 + yy, mm - 1, dd, hh, min, ss, ms);
}

function int(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse one log line into a normalized event, or null if the line carries
 * nothing useful (no timestamp, or no actor and no coordinates).
 *
 * @param category resolved from the source filename (see categoryFromFilename).
 */
export function parseLine(line: string, category: Category): GameEvent | null {
  const ts = TS_RE.exec(line);
  if (!ts) return null;
  const epoch = toEpoch(ts);
  const rest = ts[8] ?? "";

  // PVP: "user <name> (x,y,z) <verb> user <name> (x,y,z) ..."
  const pvp = PVP_RE.exec(rest);
  if (pvp) {
    return {
      ts: epoch,
      category,
      action: (pvp[5] ?? "hit").toLowerCase(),
      player: pvp[1] ?? null,
      steamid: null,
      x: int(pvp[2]),
      y: int(pvp[3]),
      z: int(pvp[4]),
    };
  }

  // Actor: "<steamid> \"<name>\" <action> <rest...>"
  const actor = ACTOR_RE.exec(rest);
  let steamid: string | null = null;
  let player: string | null = null;
  let action = "event";
  let coordScope = rest;
  if (actor) {
    steamid = actor[1] ?? null;
    player = actor[2] ?? null;
    // Strip trailing punctuation that Log Extender sometimes appends ("light." / "X@").
    action = (actor[3] ?? "event").replace(/[.@]+$/, "").toLowerCase() || "event";
    coordScope = actor[4] ?? "";
  }

  // Prefer a coordinate triple in the actor's portion; fall back to the whole line.
  const coord = COORD_RE.exec(coordScope) ?? COORD_RE.exec(rest);

  // A line with neither a recognized actor nor coordinates isn't plottable
  // and carries no useful structure for the heatmap — skip it.
  if (!actor && !coord) return null;

  return {
    ts: epoch,
    category,
    action,
    player,
    steamid,
    x: coord ? int(coord[1]) : null,
    y: coord ? int(coord[2]) : null,
    z: coord ? int(coord[3]) : null,
  };
}
