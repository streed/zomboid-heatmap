import type { GameEvent, HeatBin, HeatmapData, HeatPoint } from "./types.ts";

/** UTC day key "YYYY-MM-DD" for bucketing. */
function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Accumulates events into a coarse grid so the frontend gets compact weighted
 * points instead of raw events. Bins are keyed per category; each bin keeps a
 * per-day weight breakdown so a time range can be queried without rescanning.
 *
 * The aggregator is additive: each incremental scan calls {@link add}, and the
 * full state can be serialized ({@link toData}) / restored ({@link load}).
 */
export class Aggregator {
  private from = Infinity;
  private to = -Infinity;
  /** category -> "binX,binY" -> bin */
  private bins = new Map<string, Map<string, HeatBin>>();
  /** Total events seen per category, including coordinate-less ones. */
  private counts = new Map<string, number>();

  constructor(private readonly binSize: number) {}

  add(events: GameEvent[]): void {
    for (const e of events) {
      this.counts.set(e.category, (this.counts.get(e.category) ?? 0) + 1);
      if (e.ts < this.from) this.from = e.ts;
      if (e.ts > this.to) this.to = e.ts;

      if (e.x === null || e.y === null) continue; // counted, but not plottable

      const bx = Math.floor(e.x / this.binSize);
      const by = Math.floor(e.y / this.binSize);
      const key = `${bx},${by}`;

      let catBins = this.bins.get(e.category);
      if (!catBins) this.bins.set(e.category, (catBins = new Map()));

      let bin = catBins.get(key);
      if (!bin) {
        bin = {
          // Plot at the bin center, in game tile coordinates.
          x: bx * this.binSize + this.binSize / 2,
          y: by * this.binSize + this.binSize / 2,
          weight: 0,
          byDay: {},
        };
        catBins.set(key, bin);
      }
      bin.weight += 1;
      const day = dayKey(e.ts);
      bin.byDay[day] = (bin.byDay[day] ?? 0) + 1;
    }
  }

  /** Inclusive epoch-ms bounds of all events, or null when empty. */
  range(): { from: number; to: number } | null {
    return this.from <= this.to ? { from: this.from, to: this.to } : null;
  }

  /** Event counts per category (includes coordinate-less events). */
  categoryCounts(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }

  /**
   * Weighted points for the heatmap, filtered by category and (optionally) an
   * inclusive [from, to] epoch-ms range. When a range is given, weights are
   * recomputed from the per-day buckets that fall inside it.
   */
  query(opts: { categories?: string[]; from?: number; to?: number } = {}): HeatPoint[] {
    const cats = opts.categories ?? [...this.bins.keys()];
    const fromDay = opts.from !== undefined ? dayKey(opts.from) : null;
    const toDay = opts.to !== undefined ? dayKey(opts.to) : null;
    const points: HeatPoint[] = [];

    for (const cat of cats) {
      const catBins = this.bins.get(cat);
      if (!catBins) continue;
      for (const bin of catBins.values()) {
        let weight = bin.weight;
        if (fromDay !== null || toDay !== null) {
          weight = 0;
          for (const [day, w] of Object.entries(bin.byDay)) {
            if (fromDay !== null && day < fromDay) continue;
            if (toDay !== null && day > toDay) continue;
            weight += w;
          }
        }
        if (weight > 0) points.push({ x: bin.x, y: bin.y, weight });
      }
    }
    return points;
  }

  /** Serialize the full aggregate (for persistence). */
  toData(): HeatmapData {
    const categories: Record<string, HeatBin[]> = {};
    for (const [cat, catBins] of this.bins) categories[cat] = [...catBins.values()];
    const range = this.range();
    return {
      from: range?.from ?? 0,
      to: range?.to ?? 0,
      binSize: this.binSize,
      categories,
    };
  }

  /** Restore a previously serialized aggregate (replaces current state). */
  load(data: HeatmapData, counts?: Record<string, number>): void {
    this.bins.clear();
    this.counts.clear();
    // toData() writes from=to=0 for an empty aggregate; treat that as "no range".
    const empty = data.from === 0 && data.to === 0;
    this.from = empty ? Infinity : data.from;
    this.to = empty ? -Infinity : data.to;
    for (const [cat, bins] of Object.entries(data.categories)) {
      const map = new Map<string, HeatBin>();
      for (const bin of bins) {
        const bx = Math.floor(bin.x / this.binSize);
        const by = Math.floor(bin.y / this.binSize);
        map.set(`${bx},${by}`, bin);
      }
      this.bins.set(cat, map);
    }
    if (counts) for (const [c, n] of Object.entries(counts)) this.counts.set(c, n);
  }
}
