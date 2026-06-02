import L from "leaflet";
import "leaflet.heat";
import type { DeathInfo, HeatPoint, MapMeta, PlayerInfo } from "../src/types.ts";
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
const PLAYER_POLL_MS = 15_000; // live positions update faster than the heatmap
const el = (id: string) => document.getElementById(id)!;

let meta: MapMeta;
let map: L.Map;
let heat: L.HeatLayer;
let days: string[] = [];
const selected = new Set<string>();

// Live-player marker layer, keyed by steamid so markers move instead of churn.
let playerLayer: L.LayerGroup;
const playerMarkers = new Map<string, L.CircleMarker>();
let showPlayers = true;
/** When set to a steamid, the heatmap shows only that player's activity. */
let playerFilter = "";
/** Death markers, shown only while filtered to a specific player. */
let deathLayer: L.LayerGroup;

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
  void refreshDeaths(); // deaths depend on the same player + time filters
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
  if (playerFilter) q.set("player", playerFilter);

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

  // Open zoomed to where the action is (the iso image is mostly empty corners),
  // then back off one level so more of the map is visible on load.
  if (fitToData && latlngs.length) {
    map.fitBounds(L.latLngBounds(latlngs).pad(0.5), { maxZoom: meta.maxLevel - 4 });
    map.setZoom(Math.max(map.getZoom() - 1, map.getMinZoom()));
  }
}

// ---- Live players ----------------------------------------------------------

function playerTooltip(p: PlayerInfo): string {
  const bits = [`<b>${escapeHtml(p.name ?? p.steamid)}</b>`];
  if (p.profession) bits.push(escapeHtml(p.profession));
  const stats: string[] = [];
  if (p.kills != null) stats.push(`${p.kills} kills`);
  if (p.hours != null) stats.push(`${Math.round(p.hours)}h`);
  if (p.health != null) stats.push(`${p.health}hp${p.infected ? " · infected" : ""}`);
  if (stats.length) bits.push(stats.join(" · "));
  return bits.join("<br>");
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** Pull players and reconcile the marker layer, roster list, and filter list. */
async function refreshPlayers(): Promise<void> {
  let players: PlayerInfo[];
  try {
    // `all=1` so the filter dropdown includes offline players (historical
    // activity); markers + roster still only show the online ones.
    ({ players } = await getJSON<{ players: PlayerInfo[] }>("api/players?all=1"));
  } catch {
    return; // transient; keep existing markers and try next tick
  }

  buildPlayerFilter(players);
  const online = players.filter((p) => p.online);

  const seen = new Set<string>();
  for (const p of online) {
    if (p.x === null || p.y === null) continue;
    seen.add(p.steamid);
    const ll = gameToLatLng(p.x, p.y);
    let marker = playerMarkers.get(p.steamid);
    if (!marker) {
      marker = L.circleMarker(ll, {
        radius: 6,
        color: "#fff",
        weight: 2,
        fillColor: "#33d17a",
        fillOpacity: 0.9,
      });
      marker.addTo(playerLayer);
      playerMarkers.set(p.steamid, marker);
    } else {
      marker.setLatLng(ll);
    }
    marker.setStyle({ fillColor: p.infected ? "#e01b24" : "#33d17a" });
    marker.bindTooltip(playerTooltip(p), { direction: "top", offset: [0, -4] });
  }

  // Drop markers for players no longer online.
  for (const [id, marker] of playerMarkers) {
    if (!seen.has(id)) {
      playerLayer.removeLayer(marker);
      playerMarkers.delete(id);
    }
  }

  renderRoster(online);
}

const DEATH_ICON = L.divIcon({
  className: "death-marker",
  html: "☠",
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});

/** Show death markers for the filtered player; clear them otherwise. */
async function refreshDeaths(): Promise<void> {
  deathLayer.clearLayers();
  if (!playerFilter) return; // deaths shown only when filtered to one player

  const q = new URLSearchParams({ player: playerFilter });
  const { from, to } = currentRange();
  if (from !== undefined) q.set("from", String(from));
  if (to !== undefined) q.set("to", String(to));

  let deaths: DeathInfo[];
  try {
    ({ deaths } = await getJSON<{ deaths: DeathInfo[] }>(`api/deaths?${q}`));
  } catch {
    return;
  }
  if (!playerFilter) return; // selection changed while fetching

  for (const d of deaths) {
    const when = new Date(d.ts).toISOString().replace("T", " ").slice(0, 16);
    const survived = d.hours != null ? ` · survived ${Math.round(d.hours)}h` : "";
    L.marker(gameToLatLng(d.x, d.y), { icon: DEATH_ICON })
      .bindTooltip(`Died ${when} UTC${survived}`, { direction: "top", offset: [0, -8] })
      .addTo(deathLayer);
  }
}

/** Populate the player-filter dropdown, preserving the current selection. */
function buildPlayerFilter(players: PlayerInfo[]): void {
  const sel = el("player-filter") as HTMLSelectElement;
  const sorted = [...players].sort((a, b) =>
    (a.name ?? a.steamid).localeCompare(b.name ?? b.steamid),
  );
  const wanted = `<option value="">All players</option>` +
    sorted
      .map(
        (p) =>
          `<option value="${p.steamid}">${escapeHtml(p.name ?? p.steamid)}` +
          `${p.online ? "" : " (offline)"}</option>`,
      )
      .join("");
  if (sel.dataset.sig === wanted) return; // roster unchanged; don't disturb focus
  sel.dataset.sig = wanted;
  sel.innerHTML = wanted;
  // A previously-selected player who dropped off the list falls back to "all".
  sel.value = players.some((p) => p.steamid === playerFilter) ? playerFilter : "";
  playerFilter = sel.value;
}

function renderRoster(players: PlayerInfo[]): void {
  el("players-count").textContent = `(${players.length})`;
  const box = el("players");
  if (players.length === 0) {
    box.innerHTML = `<span class="muted">none online</span>`;
    return;
  }
  box.innerHTML = "";
  for (const p of [...players].sort((a, b) => (b.kills ?? 0) - (a.kills ?? 0))) {
    const row = document.createElement("div");
    row.className = "player-row";
    const dot = document.createElement("span");
    dot.className = "player-dot";
    dot.style.background = p.infected ? "#e01b24" : "#33d17a";
    const name = document.createElement("span");
    name.className = "player-name";
    name.textContent = p.name ?? p.steamid;
    const meta = document.createElement("span");
    meta.className = "muted player-meta";
    meta.textContent = p.kills != null ? `${p.kills} kills` : "";
    row.append(dot, name, meta);
    // Click a roster row to pan to that player.
    if (p.x !== null && p.y !== null) {
      row.style.cursor = "pointer";
      row.addEventListener("click", () => map.panTo(gameToLatLng(p.x!, p.y!)));
    }
    box.append(row);
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

  playerLayer = L.layerGroup().addTo(map);
  deathLayer = L.layerGroup().addTo(map);

  buildCategoryControls();
  buildTimeControls();
  buildRadiusControl();
  el("collapse").addEventListener("click", () => el("panel").classList.toggle("collapsed"));

  // Live-player toggle: add/remove the marker layer.
  const playersCb = el("show-players") as HTMLInputElement;
  showPlayers = params.get("players") !== "0";
  playersCb.checked = showPlayers;
  if (!showPlayers) map.removeLayer(playerLayer);
  playersCb.addEventListener("change", () => {
    showPlayers = playersCb.checked;
    if (showPlayers) {
      playerLayer.addTo(map);
      void refreshPlayers();
    } else {
      map.removeLayer(playerLayer);
    }
  });

  // Player heatmap filter.
  playerFilter = params.get("player") ?? "";
  const playerSel = el("player-filter") as HTMLSelectElement;
  playerSel.addEventListener("change", () => {
    playerFilter = playerSel.value;
    void refreshHeat();
    void refreshDeaths();
  });

  // Optional fixed initial zoom for embeds (e.g. ?zoom=14); otherwise fit to data.
  const zoomParam = params.get("zoom");
  if (zoomParam !== null && Number.isFinite(Number(zoomParam))) {
    map.setView(bounds.getCenter(), Number(zoomParam));
    await refreshHeat(false);
  } else {
    await refreshHeat(true);
  }

  // Live players: initial pull + its own faster poll.
  if (showPlayers) await refreshPlayers();
  setInterval(() => {
    if (showPlayers) void refreshPlayers();
  }, PLAYER_POLL_MS);

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
