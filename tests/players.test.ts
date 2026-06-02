import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlayerTracker } from "../src/players.ts";
import type { GameEvent } from "../src/types.ts";

const T0 = Date.UTC(2026, 5, 2, 3, 0, 0);

function pev(partial: Partial<GameEvent>): GameEvent {
  return {
    ts: T0,
    category: "player",
    action: "tick",
    player: "alice",
    steamid: "111",
    x: 8000,
    y: 11000,
    z: 0,
    ...partial,
  };
}

// A generous staleness window so test events all count as "recent".
const tracker = () => new PlayerTracker(":memory:", 60 * 60_000);

describe("PlayerTracker", () => {
  test("upserts latest position + metrics per steamid", () => {
    const t = tracker();
    t.update([
      pev({
        action: "connected",
        details: {
          profession: "lumberjack",
          kills: 2,
          hours: 6,
          health: 100,
          infected: false,
          perks: { Axe: 5 },
          traits: ["Fit"],
        },
      }),
      pev({ ts: T0 + 1000, x: 8010, y: 11010 }), // later tick moves the marker
    ]);

    const [p] = t.list({ now: T0 + 2000 });
    expect(p).toMatchObject({
      steamid: "111",
      name: "alice",
      x: 8010,
      y: 11010,
      online: true,
      profession: "lumberjack", // preserved from the connect line (tick lacked it)
      kills: 2,
      perks: { Axe: 5 },
      traits: ["Fit"],
    });
    expect(t.count()).toBe(1);
  });

  test("kills accumulate across deaths/respawns (game resets per-life count)", () => {
    const t = tracker();
    const D = (kills: number) => ({
      profession: null,
      kills,
      hours: null,
      health: null,
      infected: null,
      perks: null,
      traits: null,
    });
    t.update([
      pev({ ts: T0 + 0, details: D(2) }),
      pev({ ts: T0 + 1, details: D(11) }), // same life, +9
      pev({ ts: T0 + 2, details: D(0) }), // respawned -> reset, no negative
      pev({ ts: T0 + 3, details: D(3) }), // new life, +3
    ]);
    expect(t.list({ now: T0 + 100 })[0]!.kills).toBe(14); // 11 (life 1) + 3 (life 2)
  });

  test("does not regress to an older out-of-order event", () => {
    const t = tracker();
    t.update([pev({ ts: T0 + 5000, x: 8010, y: 11010 })]);
    t.update([pev({ ts: T0, x: 9999, y: 9999 })]); // older — must be ignored
    expect(t.list({ now: T0 + 6000 })[0]).toMatchObject({ x: 8010, y: 11010 });
  });

  test("disconnect marks the player offline; onlineOnly filters them out", () => {
    const t = tracker();
    t.update([pev({ action: "connected" })]);
    t.update([pev({ ts: T0 + 1000, action: "disconnected", x: 8050, y: 11050 })]);

    const [all] = t.list({ now: T0 + 2000 });
    expect(all).toMatchObject({ online: false, lastAction: "disconnected", x: 8050 });
    expect(t.list({ onlineOnly: true, now: T0 + 2000 })).toHaveLength(0);
  });

  test("staleness: a player not seen within the window (wall-clock) is offline", () => {
    const t = new PlayerTracker(":memory:", 10 * 60_000); // 10-min window
    t.update([pev({ steamid: "old", ts: T0, action: "tick" })]);
    t.update([pev({ steamid: "fresh", ts: T0 + 30 * 60_000, action: "tick" })]);
    // "now" is just after the fresh tick; "old" is 30 min behind -> offline.
    const online = t
      .list({ onlineOnly: true, now: T0 + 30 * 60_000 + 1000 })
      .map((p) => p.steamid);
    expect(online).toEqual(["fresh"]);
  });

  test("reset() clears the table", () => {
    const t = tracker();
    t.update([pev({})]);
    expect(t.count()).toBe(1);
    t.reset();
    expect(t.count()).toBe(0);
  });

  test("ignores non-player events for the roster", () => {
    const t = tracker();
    t.update([pev({ category: "map", action: "built" })]);
    expect(t.count()).toBe(0);
  });

  describe("per-player heatmap (filter by player)", () => {
    test("accumulates binned points and filters by player/category/time", () => {
      const t = new PlayerTracker(":memory:", 60 * 60_000, 10); // binSize 10
      const day2 = T0 + 24 * 60 * 60_000;
      t.update([
        pev({ steamid: "a", x: 100, y: 200 }), // bin 10,20
        pev({ steamid: "a", x: 105, y: 209 }), // same bin -> weight 2
        pev({ steamid: "a", x: 300, y: 400, category: "cmd" }), // bin 30,40
        pev({ steamid: "b", x: 100, y: 200 }), // different player
        pev({ steamid: "a", ts: day2, x: 500, y: 600 }), // next day, bin 50,60
      ]);

      // Player a, all categories/time: three bins.
      const all = t.heatmap("a");
      expect(all).toHaveLength(3);
      const co = all.find((p) => p.x === 105 && p.y === 205);
      expect(co?.weight).toBe(2); // co-located -> bin center (105,205), summed

      // Player b doesn't share a's bins.
      expect(t.heatmap("b")).toEqual([{ x: 105, y: 205, weight: 1 }]);

      // Category filter keeps only the cmd bin.
      expect(t.heatmap("a", { categories: ["cmd"] })).toEqual([
        { x: 305, y: 405, weight: 1 },
      ]);

      // Time filter keeps only day-2 activity.
      const onlyDay2 = t.heatmap("a", { from: day2, to: day2 + 1000 });
      expect(onlyDay2).toEqual([{ x: 505, y: 605, weight: 1 }]);
    });

    test("reset() clears per-player points too (backfill rebuild)", () => {
      const t = tracker();
      t.update([pev({ steamid: "a", x: 100, y: 200 })]);
      expect(t.heatmap("a")).toHaveLength(1);
      t.reset();
      expect(t.heatmap("a")).toHaveLength(0);
    });
  });

  describe("deaths", () => {
    const death = (over: Partial<GameEvent>) =>
      pev({
        action: "died",
        details: { profession: null, kills: null, hours: 7, health: null, infected: null, perks: null, traits: null },
        ...over,
      });

    test("records death locations and filters by player/time", () => {
      const t = tracker();
      const day2 = T0 + 24 * 60 * 60_000;
      t.update([
        death({ steamid: "a", ts: T0, x: 8188, y: 11563, z: 0 }),
        death({ steamid: "a", ts: day2, x: 8243, y: 12239, z: 0 }),
        death({ steamid: "b", ts: T0, x: 100, y: 200 }),
      ]);

      const a = t.deaths({ player: "a" });
      expect(a).toHaveLength(2);
      expect(a[0]).toMatchObject({ x: 8243, y: 12239, hours: 7 }); // newest first
      expect(t.deaths({ player: "a", from: day2 })).toHaveLength(1);
      expect(t.deaths()).toHaveLength(3); // all players
    });

    test("re-applying the same death events is idempotent (backfill safe)", () => {
      const t = tracker();
      const ev = death({ steamid: "a", ts: T0, x: 8188, y: 11563 });
      t.update([ev]);
      t.update([ev]); // duplicate (steamid, ts) -> ignored
      expect(t.deaths({ player: "a" })).toHaveLength(1);
    });

    test("reset() clears deaths", () => {
      const t = tracker();
      t.update([death({ steamid: "a", ts: T0, x: 1, y: 2 })]);
      t.reset();
      expect(t.deaths()).toHaveLength(0);
    });
  });

  test("self-heals a read-only players.db by recreating it", () => {
    const dir = mkdtempSync(join(tmpdir(), "pzhm-"));
    const dbPath = join(dir, "players.db");
    try {
      const t0 = new PlayerTracker(dbPath, 30 * 60_000, 10);
      t0.update([pev({ steamid: "old", x: 1, y: 2 })]);
      t0.close();
      chmodSync(dbPath, 0o444); // read-only -> writes would throw SQLITE_READONLY

      // Re-opening detects the read-only file and recreates a fresh, writable DB.
      const t1 = new PlayerTracker(dbPath, 30 * 60_000, 10);
      expect(() => t1.update([pev({ steamid: "new", x: 3, y: 4 })])).not.toThrow();
      expect(t1.count()).toBe(1); // fresh DB: only the post-heal write survives
      t1.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
