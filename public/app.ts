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
/** Categories ever shown — so a meta-refresh defaults only *new* ones to on. */
const knownCats = new Set<string>();
let categoriesInit = false;
let timeInit = false;

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

/** Inverse of {@link gameToLatLng}: a Leaflet LatLng back to game tile (x, y). */
function latLngToGame(ll: L.LatLng): { x: number; y: number } {
  const pt = map.project(ll, meta.maxLevel);
  const p = meta.projection;
  if (p.mode === "ortho") return { x: pt.x / p.pixelsPerTile, y: pt.y / p.pixelsPerTile };
  const u = (pt.x - p.originX) / (32 * p.multiply); // a - b
  const v = (pt.y - p.originY) / (16 * p.multiply); // a + b
  return { x: (u + v) / 2 + p.offsetX, y: (v - u) / 2 + p.offsetY };
}

/** Read the shared view (?center=x,y in game tiles & ?zoom=N) from the URL. */
function parseSharedView(): { center: L.LatLng; zoom: number } | null {
  const c = params.get("center");
  const z = params.get("zoom");
  if (!c || z === null) return null;
  const [x, y] = c.split(",").map(Number);
  const zoom = Number(z);
  if (![x, y, zoom].every(Number.isFinite)) return null;
  return { center: gameToLatLng(x!, y!), zoom };
}

/**
 * Write the full UI state to the URL (replacing history, not stacking) so the
 * link captures exactly what's on screen: view, categories, time range,
 * intensity radius, player filter and the live-players toggle.
 */
function syncUrl(): void {
  const p = new URLSearchParams();

  const g = latLngToGame(map.getCenter());
  p.set("center", `${Math.round(g.x)},${Math.round(g.y)}`);
  p.set("zoom", String(map.getZoom()));

  p.set("cat", [...selected].join(","));

  const range = selectedDays();
  if (range) {
    p.set("from", range.from);
    p.set("to", range.to);
  }

  p.set("radius", (el("radius") as HTMLInputElement).value);
  if (playerFilter) p.set("player", playerFilter);
  if (!showPlayers) p.set("players", "0");

  // Commas are valid in a query value; keep them unescaped for readable URLs.
  history.replaceState(null, "", `${location.pathname}?${p.toString().replace(/%2C/g, ",")}`);
}

/** Selected day-range as date strings, or null when the whole range is active. */
function selectedDays(): { from: string; to: string } | null {
  if (days.length === 0) return null;
  const lo = Math.min(+(el("time-start") as HTMLInputElement).value, +(el("time-end") as HTMLInputElement).value);
  const hi = Math.max(+(el("time-start") as HTMLInputElement).value, +(el("time-end") as HTMLInputElement).value);
  if (lo === 0 && hi === days.length - 1) return null;
  return { from: days[lo]!, to: days[hi]! };
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
  // then step in one level so the action fills more of the screen on load.
  if (fitToData && latlngs.length) {
    map.fitBounds(L.latLngBounds(latlngs).pad(0.5), { maxZoom: meta.maxLevel - 4 });
    map.setZoom(Math.min(map.getZoom() + 1, map.getMaxZoom()));
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

  // First build seeds `selected` from the URL (or all-on); later rebuilds (on a
  // meta-refresh) preserve the user's current selection and only default
  // genuinely new categories to on.
  const initial = categoriesInit ? null : (params.get("cat")?.split(",").filter(Boolean) ?? null);
  for (const [cat] of entries) {
    if (knownCats.has(cat)) continue;
    knownCats.add(cat);
    if (initial ? initial.includes(cat) : true) selected.add(cat);
  }
  categoriesInit = true;
  // No categories selected (empty ?cat=, or a shared link with none) means
  // "show everything" rather than a blank map.
  if (selected.size === 0) for (const [cat] of entries) selected.add(cat);

  for (const [cat, count] of entries) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(cat);
    cb.addEventListener("change", () => {
      cb.checked ? selected.add(cat) : selected.delete(cat);
      if (selected.size === 0) {
        for (const [c] of entries) selected.add(c); // unchecked the last -> all back on
        buildCategoryControls(); // re-render so every box shows checked
      }
      void refreshHeat();
      syncUrl();
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
  // Remember the current selection (as day strings) so growing the range on a
  // meta-refresh doesn't reset what the user picked.
  const prev = timeInit ? selectedDays() : null;
  days = enumerateDays(meta.eventsFrom, meta.eventsTo);
  const start = el("time-start") as HTMLInputElement;
  const end = el("time-end") as HTMLInputElement;
  for (const s of [start, end]) {
    s.min = "0";
    s.max = String(days.length - 1);
  }

  // Restore selection: from the URL on first build, else the prior selection.
  const wanted = timeInit
    ? prev
    : params.get("from") && params.get("to")
      ? { from: params.get("from")!, to: params.get("to")! }
      : null;
  const idx = (day: string, fallback: number) => {
    const i = days.indexOf(day);
    return i === -1 ? fallback : i;
  };
  start.value = String(wanted ? idx(wanted.from, 0) : 0);
  end.value = String(wanted ? idx(wanted.to, days.length - 1) : days.length - 1);
  timeInit = true;

  const update = (fromUser: boolean) => {
    el("time-label").textContent =
      `${days[Math.min(+start.value, +end.value)]} → ${days[Math.max(+start.value, +end.value)]}`;
    void refreshHeat();
    if (fromUser) syncUrl();
  };
  // Assign (not addEventListener) so re-running on a meta-refresh replaces the
  // handler instead of stacking duplicates on these persistent inputs.
  start.oninput = () => update(true);
  end.oninput = () => update(true);
  update(false);
}

function buildRadiusControl(): void {
  const slider = el("radius") as HTMLInputElement;
  const initial = params.get("radius");
  if (initial) slider.value = initial;
  const apply = (fromUser: boolean) => {
    heat.setOptions({ radius: +slider.value, blur: +slider.value * 0.75 });
    if (fromUser) syncUrl();
  };
  slider.addEventListener("input", () => apply(true));
  apply(false);
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
    syncUrl();
  });

  // Player heatmap filter.
  playerFilter = params.get("player") ?? "";
  const playerSel = el("player-filter") as HTMLSelectElement;
  playerSel.addEventListener("change", () => {
    playerFilter = playerSel.value;
    syncUrl();
    void refreshHeat();
    void refreshDeaths();
  });

  // Restore a shared view (?center=x,y in game tiles & ?zoom=N) if present; else
  // an embed's fixed ?zoom=N at the map center; else fit to where the action is.
  const shared = parseSharedView();
  const zoomParam = params.get("zoom");
  if (shared) {
    map.setView(shared.center, shared.zoom);
    await refreshHeat(false);
  } else if (zoomParam !== null && Number.isFinite(Number(zoomParam))) {
    map.setView(bounds.getCenter(), Number(zoomParam));
    await refreshHeat(false);
  } else {
    await refreshHeat(true);
  }

  // Keep the URL in sync with the view so it's copy-pasteable / sharable. Only
  // attach after the initial view is set so the restore above isn't overwritten
  // mid-flight; one explicit sync captures the resolved state.
  map.on("moveend zoomend", syncUrl);
  syncUrl();

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
