import { describe, expect, test } from "bun:test";
import { Aggregator } from "../src/aggregate.ts";
import type { GameEvent } from "../src/types.ts";

function ev(partial: Partial<GameEvent>): GameEvent {
  return {
    ts: Date.UTC(2026, 4, 27, 12, 0, 0),
    category: "map",
    action: "taken",
    player: "p",
    steamid: "1",
    x: 100,
    y: 200,
    z: 0,
    ...partial,
  };
}

describe("Aggregator", () => {
  test("bins co-located events into one weighted point at the bin center", () => {
    const agg = new Aggregator(10);
    // 100..109 and 200..209 fall in the same 10-tile bin.
    agg.add([ev({ x: 100, y: 200 }), ev({ x: 105, y: 209 }), ev({ x: 109, y: 200 })]);

    const points = agg.query({ categories: ["map"] });
    expect(points).toHaveLength(1);
    expect(points[0]).toEqual({ x: 105, y: 205, weight: 3 }); // bin center, summed
  });

  test("separates categories and reports counts (incl. coordinate-less)", () => {
    const agg = new Aggregator(10);
    agg.add([ev({ category: "map" }), ev({ category: "pvp" }), ev({ category: "pvp", x: null, y: null })]);

    expect(agg.categoryCounts()).toEqual({ map: 1, pvp: 2 });
    expect(agg.query({ categories: ["map"] })).toHaveLength(1);
    // pvp has 2 events but one lacks coords, so only 1 plottable bin.
    expect(agg.query({ categories: ["pvp"] })).toHaveLength(1);
  });

  test("filters by time range using day buckets", () => {
    const agg = new Aggregator(10);
    const day1 = Date.UTC(2026, 4, 26, 8, 0, 0);
    const day2 = Date.UTC(2026, 4, 27, 8, 0, 0);
    agg.add([ev({ ts: day1 }), ev({ ts: day2 }), ev({ ts: day2 })]);

    const all = agg.query({ categories: ["map"] });
    expect(all[0]!.weight).toBe(3);

    const onlyDay2 = agg.query({ categories: ["map"], from: day2, to: day2 });
    expect(onlyDay2[0]!.weight).toBe(2);

    const onlyDay1 = agg.query({ categories: ["map"], from: day1, to: day1 });
    expect(onlyDay1[0]!.weight).toBe(1);
  });

  test("toData / load round-trips the aggregate", () => {
    const agg = new Aggregator(10);
    agg.add([ev({ x: 100, y: 200 }), ev({ x: 105, y: 205 })]);
    const data = agg.toData();
    const counts = agg.categoryCounts();

    const restored = new Aggregator(10);
    restored.load(data, counts);
    expect(restored.query({ categories: ["map"] })).toEqual(agg.query({ categories: ["map"] }));
    expect(restored.categoryCounts()).toEqual(counts);
    expect(restored.range()).toEqual(agg.range());
  });

  test("empty aggregate has no range", () => {
    expect(new Aggregator(10).range()).toBeNull();
  });
});
