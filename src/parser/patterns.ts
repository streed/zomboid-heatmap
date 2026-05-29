import type { Category } from "../types.ts";

// Regexes for the Project Zomboid / Log Extender log line shapes.
//
// Every line begins with a `[DD-MM-YY HH:MM:SS.sss]` timestamp. After that,
// Log Extender uses two broad shapes:
//
//   actor:  <steamid> "<name>" <action> <stuff...> at|@ X,Y,Z.
//   pvp:    user <name> (X,Y,Z) <verb> user <name> (X,Y,Z) with <weapon> ...
//
// Coordinates are world tiles as `X,Y,Z`. We capture the *actor's* position
// (for pvp lines, the attacker — the first coordinate triple).

/** Leading timestamp; group 8 is the remainder of the line. */
export const TS_RE =
  /^\[(\d{2})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\]\s*(.*)$/;

/** Actor shape after the timestamp: steamid, quoted name, action verb, rest. */
export const ACTOR_RE = /^(\d{6,})\s+"([^"]*)"\s+(\S+)\s*(.*)$/;

/** PVP shape: attacker name + coords + verb (e.g. "hit"). Name may contain spaces. */
export const PVP_RE =
  /^user\s+(.+?)\s+\((-?\d+),(-?\d+),(-?\d+)\)\s+(\S+)\s+user\b/i;

/** First `X,Y,Z` coordinate triple anywhere in a string. Non-global on purpose. */
export const COORD_RE = /(-?\d+),(-?\d+),(-?\d+)/;

/** Map a log file's name to an event category based on its suffix. */
export function categoryFromFilename(filename: string): Category {
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
    default:
      // user/chat/perklog/debuglog-server and anything else: usually no coords.
      return "other";
  }
}
