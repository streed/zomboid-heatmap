import type { Category, GameEvent, PlayerDetails } from "../types.ts";
import { ACTOR_RE, COORD_RE, PVP_RE, TS_RE } from "./patterns.ts";

// `_player.txt` connect/tick lines append flat JSON blobs:
//   ... perks={...} traits=[...] stats={"profession":..,"kills":..,"hours":..}
//       health={"health":..,"infected":..} safehouse owner=(..) (x,y,z).
// None of these objects nest, so a `{...}` / `[...]` slice is safe to JSON.parse.
// PerkLog bracketed line: [steamid][name][x,y,z][EventType][Hours Survived: N].
const BRACKET_RE = /^\[(\d{6,})\]\[([^\]]*)\]\[(-?\d+),(-?\d+),(-?\d+)\]\[([^\]]+)\]/;

const PERKS_RE = /perks=(\{[^}]*\})/;
const TRAITS_RE = /traits=(\[[^\]]*\])/;
const STATS_RE = /stats=(\{[^}]*\})/;
const HEALTH_RE = /health=(\{[^}]*\})/;

function jsonOr<T>(re: RegExp, s: string, fallback: T): T {
  const m = re.exec(s);
  if (!m) return fallback;
  try {
    return JSON.parse(m[1]!) as T;
  } catch {
    return fallback;
  }
}

/** Pull perks/traits/stats/health out of a player line's remainder, if present. */
function parsePlayerDetails(rest: string): PlayerDetails | undefined {
  if (!/perks=|stats=|health=|traits=/.test(rest)) return undefined;
  const stats = jsonOr<{ profession?: string; kills?: number; hours?: number }>(
    STATS_RE,
    rest,
    {},
  );
  const health = jsonOr<{ health?: number; infected?: boolean }>(HEALTH_RE, rest, {});
  return {
    profession: stats.profession ?? null,
    kills: typeof stats.kills === "number" ? stats.kills : null,
    hours: typeof stats.hours === "number" ? stats.hours : null,
    health: typeof health.health === "number" ? health.health : null,
    infected: typeof health.infected === "boolean" ? health.infected : null,
    perks: jsonOr<Record<string, number> | null>(PERKS_RE, rest, null),
    traits: jsonOr<string[] | null>(TRAITS_RE, rest, null),
  };
}

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

  // PerkLog bracketed shape: "[steamid][name][x,y,z][<Event>][Hours Survived: N]."
  // We only care about deaths here; login/skill-dump lines are dropped so they
  // don't pollute the heatmap. A death folds into the player category so it's
  // attributed to the player (and feeds the death-marker store).
  const bracket = BRACKET_RE.exec(rest);
  if (bracket) {
    if (bracket[6] !== "Died") return null;
    const hours = /Hours Survived:\s*([\d.]+)/.exec(rest);
    return {
      ts: epoch,
      category: "player",
      action: "died",
      player: bracket[2] || null,
      steamid: bracket[1] ?? null,
      x: int(bracket[3]),
      y: int(bracket[4]),
      z: int(bracket[5]),
      details: {
        profession: null,
        kills: null,
        hours: hours ? Number(hours[1]) : null,
        health: null,
        infected: null,
        perks: null,
        traits: null,
      },
    };
  }

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

  const event: GameEvent = {
    ts: epoch,
    category,
    action,
    player,
    steamid,
    x: coord ? int(coord[1]) : null,
    y: coord ? int(coord[2]) : null,
    z: coord ? int(coord[3]) : null,
  };

  // Attach per-player metrics for the live-player tracker (player logs only).
  if (category === "player") {
    const details = parsePlayerDetails(coordScope);
    if (details) event.details = details;
  }
  return event;
}
