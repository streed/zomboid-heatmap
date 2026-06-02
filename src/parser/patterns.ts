import type { Category } from "../types.ts";

// Regexes for the Project Zomboid / Log Extender log line shapes.
//
// Every line begins with a `[DD-MM-YY HH:MM:SS.sss]` timestamp, optionally
// followed by a bracketed log level (`[INFO]`, `[DEBUG]`, …) that newer Log
// Extender builds emit. After that, two broad shapes:
//
//   actor:  <steamid> "<name>" <action> <stuff...> at|@ X,Y,Z.
//   pvp:    user <name> (X,Y,Z) <verb> user <name> (X,Y,Z) with <weapon> ...
//
// Coordinates are world tiles as `X,Y,Z`. We capture the *actor's* position
// (for pvp lines, the attacker — the first coordinate triple).

/** Leading timestamp + optional `[LEVEL]` tag; group 8 is the remainder. */
export const TS_RE =
  /^\[(\d{2})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\](?:\[[A-Za-z]+\])?\s*(.*)$/;

/** Actor shape after the timestamp: steamid, quoted name, action verb, rest. */
export const ACTOR_RE = /^(\d{6,})\s+"([^"]*)"\s+(\S+)\s*(.*)$/;

/** PVP shape: attacker name + coords + verb (e.g. "hit"). The name may be
 *  quoted and may contain spaces; a coordinate triple is required so the
 *  newer coordinate-less "user <name> restore safety" lines don't match. */
export const PVP_RE =
  /^user\s+"?(.+?)"?\s+\((-?\d+),(-?\d+),(-?\d+)\)\s+(\S+)\s+user\b/i;

/** First `X,Y,Z` coordinate triple anywhere in a string. Non-global on purpose. */
export const COORD_RE = /(-?\d+),(-?\d+),(-?\d+)/;

/**
 * Map a log file's name to an event category based on its suffix, or `null`
 * when the file is not a coordinate-bearing actor log we want to plot.
 *
 * Project Zomboid / Log Extender writes many sibling logs in the same folder
 * (`_item`, `_craft`, `_chat`, `_user`, `_PerkLog`, `_ClientActionLog`,
 * `_DebugLog-server`, …). Most carry no positions, and some — the debug log in
 * particular — contain bare number sequences like `1780073711006> 2,492,960>`
 * that the coordinate regex would happily mistake for tiles, flooding the map
 * with garbage. So we *allowlist* the known spatial logs and skip everything
 * else rather than defaulting unknown files to a catch-all category.
 */
export function categoryFromFilename(filename: string): Category | null {
  // Grab the token before ".txt" (after the final underscore if present).
  const base = filename.replace(/\.txt$/i, "");
  const suffix = (base.split("_").pop() ?? base).toLowerCase();
  switch (suffix) {
    case "map":
      return "map";
    case "cmd":
      return "cmd";
    case "pvp":
      return "pvp";
    case "vehicle":
      return "vehicle";
    case "player":
      return "player";
    case "admin":
      return "admin";
    case "safehouse":
      return "safehouse";
    case "perklog":
      // PerkLog carries login/skill dumps (dropped by the parser) plus the
      // attributable `[Died]` records we want for player death markers; treat
      // it as a player-category source so deaths fold into per-player data.
      return "player";
    default:
      // item/craft/chat/user/debuglog-server/etc.: no usable coordinates
      // (or only spurious ones). Don't ingest them.
      return null;
  }
}
