import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Aggregator } from "../src/aggregate.ts";
import { StateStore } from "../src/state.ts";
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

/** Build an aggregator with a couple of events for round-trip checks. */
function sampleAggregator(): Aggregator {
  const agg = new Aggregator(10);
  agg.add([
    ev({ x: 100, y: 200, ts: Date.UTC(2026, 4, 26, 8, 0, 0) }),
    ev({ x: 105, y: 209, ts: Date.UTC(2026, 4, 27, 8, 0, 0) }),
    ev({ category: "pvp", x: 300, y: 400 }),
    ev({ category: "pvp", x: null, y: null }), // counted, not plottable
  ]);
  return agg;
}

describe("StateStore", () => {
  test("round-trips offsets, aggregate, counts, and lastUpdated", () => {
    const store = new StateStore(new Database(":memory:"), 10);
    const agg = sampleAggregator();
    const offsets = { "/logs/a_map.txt": 1234, "/logs/b_pvp.txt": 9 };

    store.save(offsets, agg.toData(), agg.categoryCounts(), 1700);

    expect(store.loadOffsets()).toEqual(offsets);
    expect(store.lastUpdated()).toBe(1700);

    const restored = new Aggregator(10);
    const r = store.loadAggregate();
    restored.load(r.data, r.counts);

    expect(restored.categoryCounts()).toEqual(agg.categoryCounts()); // incl. coordless pvp
    expect(restored.range()).toEqual(agg.range()); // epoch-ms bounds survive
    for (const cat of ["map", "pvp"]) {
      expect(restored.query({ categories: [cat] })).toEqual(agg.query({ categories: [cat] }));
    }
  });

  test("preserves per-day buckets so time-range queries still work", () => {
    const store = new StateStore(new Database(":memory:"), 10);
    const agg = sampleAggregator();
    store.save({}, agg.toData(), agg.categoryCounts(), 0);

    const restored = new Aggregator(10);
    const r = store.loadAggregate();
    restored.load(r.data, r.counts);

    const day2 = Date.UTC(2026, 4, 27, 0, 0, 0);
    expect(restored.query({ categories: ["map"], from: day2, to: day2 })).toEqual(
      agg.query({ categories: ["map"], from: day2, to: day2 }),
    );
  });

  test("save replaces prior state rather than accumulating", () => {
    const store = new StateStore(new Database(":memory:"), 10);
    store.save({ "/a.txt": 5 }, sampleAggregator().toData(), { map: 99 }, 1);
    store.save({ "/b.txt": 7 }, new Aggregator(10).toData(), {}, 2);

    expect(store.loadOffsets()).toEqual({ "/b.txt": 7 });
    expect(store.loadAggregate().counts).toEqual({});
    expect(store.loadAggregate().data.categories).toEqual({});
    expect(store.lastUpdated()).toBe(2);
  });

  test("empty store loads an empty, range-less aggregate", () => {
    const store = new StateStore(new Database(":memory:"), 10);
    const restored = new Aggregator(10);
    const r = store.loadAggregate();
    restored.load(r.data, r.counts);
    expect(restored.range()).toBeNull();
    expect(store.loadOffsets()).toEqual({});
    expect(store.lastUpdated()).toBe(0);
  });

  test("a changed bin size invalidates stored bins and offsets", () => {
    const db = new Database(":memory:");
    const agg = sampleAggregator();
    new StateStore(db, 10).save({ "/a.txt": 5 }, agg.toData(), agg.categoryCounts(), 1);

    // Reopen against the same DB with a different bin size.
    const reopened = new StateStore(db, 20);
    expect(reopened.loadOffsets()).toEqual({});
    expect(reopened.loadAggregate().data.categories).toEqual({});
    expect(reopened.loadAggregate().counts).toEqual({});
  });

  test("reset() wipes everything", () => {
    const store = new StateStore(new Database(":memory:"), 10);
    const agg = sampleAggregator();
    store.save({ "/a.txt": 5 }, agg.toData(), agg.categoryCounts(), 9);

    store.reset();

    expect(store.loadOffsets()).toEqual({});
    expect(store.loadAggregate().data.categories).toEqual({});
    expect(store.lastUpdated()).toBe(0);
  });

  test("persists across a reopen on the same DB handle", () => {
    const db = new Database(":memory:");
    const agg = sampleAggregator();
    new StateStore(db, 10).save({ "/a.txt": 42 }, agg.toData(), agg.categoryCounts(), 5);

    // A second store on the same connection (mirrors a process restart sharing
    // the file) sees the persisted rows.
    const reopened = new StateStore(db, 10);
    expect(reopened.loadOffsets()).toEqual({ "/a.txt": 42 });
    expect(reopened.lastUpdated()).toBe(5);
    expect(reopened.loadAggregate().counts).toEqual(agg.categoryCounts());
  });
});
