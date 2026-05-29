import L from "leaflet";
import "leaflet.heat";
import type { HeatPoint, MapMeta } from "../src/types.ts";
import { createDziLayer } from "./dzi-tilelayer.ts";

// ---- Helpers ---------------------------------------------------------------

const params = new URLSearchParams(location.search);

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** Inclusive list of UTC day strings ("YYYY-MM-DD") between two epochs. */
function enumerateDays(fromMs: number, toMs: number): string[] {
  const days: string[] = [];
  const d = new Date(fromMs);
  d.setUTCHours(0, 0, 0, 0);
  while (d.getTime() <= toMs) {
    days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days.length ? days : [new Date(fromMs).toISOString().slice(0, 10)];
}

const dayStartMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const dayEndMs = (day: string) => Date.parse(`${day}T23:59:59.999Z`);

// ---- App state -------------------------------------------------------------

const POLL_MS = 30_000;
const el = (id: string) => document.getElementById(id)!;

let meta: MapMeta;
let map: L.Map;
let heat: L.HeatLayer;
let days: string[] = [];
const selected = new Set<string>();

/** Project a game tile (x, y) to a full-resolution image pixel. Mirrors the
 *  community map's tileToPixel for `iso`, or a linear scale for `ortho`. */
function gameToPixel(x: number, y: number): [number, number] {
  const p = meta.projection;
  if (p.mode === "ortho") return [x * p.pixelsPerTile, y * p.pixelsPerTile];
  const a = x - p.offsetX;
  const b = y - p.offsetY;
  return [(a - b) * 32 * p.multiply + p.originX, (a + b) * 16 * p.multiply + p.originY];
}

/** Project a game tile (x, y) to a Leaflet LatLng (via the full-res pixel space). */
function gameToLatLng(x: number, y: number): L.LatLng {
  return map.unproject(gameToPixel(x, y), meta.maxLevel);
}

function currentRange(): { from?: number; to?: number } {
  if (days.length === 0) return {};
  const startIdx = +(el("time-start") as HTMLInputElement).value;
  const endIdx = +(el("time-end") as HTMLInputElement).value;
  const lo = Math.min(startIdx, endIdx);
  const hi = Math.max(startIdx, endIdx);
  // Omit bounds when the whole range is selected (lets the server skip filtering).
  if (lo === 0 && hi === days.length - 1) return {};
  return { from: dayStartMs(days[lo]!), to: dayEndMs(days[hi]!) };
}

async function refreshHeat(fitToData = false): Promise<void> {
  const cats = [...selected];
  if (cats.length === 0) {
    heat.setLatLngs([]);
    el("stat").textContent = "0 bins";
    return;
  }
  const q = new URLSearchParams({ cat: cats.join(",") });
  const { from, to } = currentRange();
  if (from !== undefined) q.set("from", String(from));
  if (to !== undefined) q.set("to", String(to));

  const { points } = await getJSON<{ binSize: number; points: HeatPoint[] }>(
    `api/heatmap?${q}`,
  );

  let maxWeight = 1;
  const latlngs: L.LatLng[] = [];
  const data: [number, number, number][] = points.map((p) => {
    if (p.weight > maxWeight) maxWeight = p.weight;
    const ll = gameToLatLng(p.x, p.y);
    latlngs.push(ll);
    return [ll.lat, ll.lng, p.weight];
  });
  heat.setOptions({ max: maxWeight });
  heat.setLatLngs(data);
  el("stat").textContent = `${points.length} bins · ${cats.length} categories`;

  // Open zoomed to where the action is (the iso image is mostly empty corners).
  if (fitToData && latlngs.length) {
    map.fitBounds(L.latLngBounds(latlngs).pad(0.5), { maxZoom: meta.maxLevel - 4 });
  }
}

// ---- UI construction -------------------------------------------------------

function buildCategoryControls(): void {
  const box = el("categories");
  box.innerHTML = "";
  const entries = Object.entries(meta.available)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  const initial = params.get("cat")?.split(",").filter(Boolean);
  for (const [cat, count] of entries) {
    const on = initial ? initial.includes(cat) : true;
    if (on) selected.add(cat);

    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = on;
    cb.addEventListener("change", () => {
      cb.checked ? selected.add(cat) : selected.delete(cat);
      void refreshHeat();
    });
    label.append(cb, document.createTextNode(` ${cat} (${count})`));
    box.append(label);
  }
}

function buildTimeControls(): void {
  if (meta.eventsFrom === null || meta.eventsTo === null) {
    days = [];
    el("time").style.display = "none";
    return;
  }
  days = enumerateDays(meta.eventsFrom, meta.eventsTo);
  const start = el("time-start") as HTMLInputElement;
  const end = el("time-end") as HTMLInputElement;
  for (const s of [start, end]) {
    s.min = "0";
    s.max = String(days.length - 1);
  }
  start.value = "0";
  end.value = String(days.length - 1);
  const update = () => {
    el("time-label").textContent =
      `${days[Math.min(+start.value, +end.value)]} → ${days[Math.max(+start.value, +end.value)]}`;
    void refreshHeat();
  };
  start.addEventListener("input", update);
  end.addEventListener("input", update);
  update();
}

function buildRadiusControl(): void {
  const slider = el("radius") as HTMLInputElement;
  const initial = params.get("radius");
  if (initial) slider.value = initial;
  const apply = () => heat.setOptions({ radius: +slider.value, blur: +slider.value * 0.75 });
  slider.addEventListener("input", apply);
  apply();
}

// ---- Bootstrap -------------------------------------------------------------

async function main(): Promise<void> {
  meta = await getJSON<MapMeta>("api/meta");
  if ((meta as unknown as { error?: string }).error) {
    el("error").textContent = `Map tiles unavailable: ${(meta as any).error}`;
    el("error").style.display = "block";
    return;
  }

  map = L.map("map", { crs: L.CRS.Simple, attributionControl: false });
  const bounds = L.latLngBounds(
    map.unproject([0, 0], meta.maxLevel),
    map.unproject([meta.imageWidth, meta.imageHeight], meta.maxLevel),
  );
  createDziLayer(meta, bounds).addTo(map);
  map.setMaxBounds(bounds);
  map.fitBounds(bounds);

  heat = L.heatLayer([], { radius: 25, blur: 18, minOpacity: 0.25, maxZoom: meta.maxLevel });
  heat.addTo(map);

  buildCategoryControls();
  buildTimeControls();
  buildRadiusControl();
  el("collapse").addEventListener("click", () => el("panel").classList.toggle("collapsed"));

  // Optional fixed initial zoom for embeds (e.g. ?zoom=14); otherwise fit to data.
  const zoomParam = params.get("zoom");
  if (zoomParam !== null && Number.isFinite(Number(zoomParam))) {
    map.setView(bounds.getCenter(), Number(zoomParam));
    await refreshHeat(false);
  } else {
    await refreshHeat(true);
  }

  // Auto-refresh: re-pull meta; if the server processed new logs, reload data.
  let lastSeen = meta.lastUpdated;
  setInterval(async () => {
    try {
      const fresh = await getJSON<MapMeta>("api/meta");
      if (fresh.lastUpdated !== lastSeen) {
        lastSeen = fresh.lastUpdated;
        meta = fresh;
        buildCategoryControls();
        buildTimeControls();
        await refreshHeat();
      }
    } catch {
      /* transient; try again next tick */
    }
  }, POLL_MS);
}

void main();
