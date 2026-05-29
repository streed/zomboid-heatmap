# zomboid-heatmap

A small web app that turns your **Project Zomboid server logs** into a **heatmap
of where things happen**, overlaid on the full Knox Country map. It is **not a
server mod** — it runs *next to* your server, reads the log directory, and serves
an `<iframe>`-embeddable map.

```
PZ server ──writes──▶ Zomboid/Logs/ ──read──▶ [ zomboid-heatmap (Bun) ] ──▶ <iframe> heatmap
                                                       │
                              community map tiles ─────┘ (proxied + cached)
```

- **Reads** `*_map.txt`, `*_cmd.txt`, `*_pvp.txt`, `*_vehicle.txt`, `*_player.txt`, … and extracts each event's `x,y,z`.
- **Aggregates** events into a grid, filterable by **category** and **time range**.
- **Overlays** a heatmap on the real game map (tiles proxied from the community map and cached to disk).
- **Refreshes** automatically every few minutes; the iframe updates itself.

---

## What you need to add to get this set up

There are **three** things to provide. Each is explained below.

### 1. Bun

Install [Bun](https://bun.sh) (v1.3+) on the machine that will run this app:

```sh
curl -fsSL https://bun.sh/install | bash
```

### 2. The **Log Extender** mod on your PZ server  ⟵ the important one

Vanilla Project Zomboid logs contain coordinates for only a handful of events.
The community **Log Extender** mod adds `x,y,z` positions to most events, which is
what makes a useful heatmap. Without it, the map will be sparse.

- Mod: **Log Extender** — <https://github.com/openzomboid/log-extender> (also on the Steam Workshop).
- Add it to your server like any other mod (e.g. in `server.ini`):
  ```ini
  Mods=log-extender
  WorkshopItems=2659216714   ; use the Workshop ID you subscribed to
  ```
- Restart the server. New log files (`*_map.txt`, `*_cmd.txt`, `*_pvp.txt`, …) will
  start appearing in `Zomboid/Logs` with coordinates.

> The parser still works on vanilla logs — you'll just get fewer geolocated events.

### 3. Network access to the community map (for the base tiles)

The base map imagery is **proxied on demand** from the public community map
(`map.projectzomboid.com`) and cached under `data/cache/`. The machine running this
app needs outbound HTTPS the first time each tile is viewed. No full download is
required (the full tileset is hundreds of GB — we only fetch what's looked at).
You can also point it at a self-hosted tileset (see [Configuration](#configuration)).

---

## Setup

```sh
git clone <this repo> && cd zomboid-heatmap
bun install

cp .env.example .env
$EDITOR .env            # set at least LOGS_DIR (and BUILD if not 41)

bun run start           # builds the frontend, then serves on PORT (default 8080)
```

Open <http://localhost:8080> to check it, then embed it:

```html
<iframe src="http://your-host:8080/" width="900" height="600" style="border:0"></iframe>
```

Embeds can be preconfigured via query params, e.g. open straight to PVP hotspots:

```html
<iframe src="http://your-host:8080/?cat=pvp&radius=30"></iframe>
```

Query params: `cat` (comma-separated categories), `radius` (heat radius),
`zoom` (fixed initial zoom level; omit to auto-fit the data).

### Try it without a server

A sample log set is included:

```sh
LOGS_DIR=./example-logs bun run start
```

---

## Configuration

All options are environment variables (see `.env.example`). Defaults in **bold**.

| Variable          | Default                       | Purpose |
|-------------------|-------------------------------|---------|
| `LOGS_DIR`        | `./logs`                      | **Required.** Path to the server's `Zomboid/Logs`. Dated subfolders are scanned too. |
| `BUILD`           | **`41`**                      | Selects the default community map + projection (`src/builds.ts`). |
| `REFRESH_MINUTES` | **`5`**                       | How often logs are re-scanned (incrementally). |
| `BIN_SIZE`        | **`10`**                      | Heatmap grid bin size, in game tiles. Larger = coarser, smaller payload. |
| `PORT`            | **`8080`**                    | HTTP port. |
| `FRAME_ANCESTORS` | **`*`**                       | CSP `frame-ancestors` — which sites may embed the iframe. |
| `DATA_DIR`        | **`./data`**                  | Tile cache + parse-state location. |
| `TILE_UPSTREAM`   | per build                     | Community map host to proxy. |
| `MAP_DESC`        | per build (`SurvivalB417812L0`) | Map folder under `<upstream>/maps/`. |
| `MAP_DESCRIPTOR`  | per build (`map.xml`)         | DZI descriptor filename. |
| `PROJECTION`      | per build (`iso`)             | `iso` (community map) or `ortho` (top-down render). |
| `WORLD_TILES_X`   | per build                     | `ortho` only: world width in tiles → pixels-per-tile. |

### Targeting Build 42

B42 enlarged the map. Set `BUILD=42` to default to `b42map.com`. Because community
B42 maps are still evolving, **verify `MAP_DESC`**: open the map site, check the
request path it loads tiles from (`…/maps/<MAP_DESC>/…`), and set `MAP_DESC`
accordingly in `.env`. If that map ships an `extra.json` it stays `iso`; if you
use a top-down (`*_top`) render, set `PROJECTION=ortho` and `WORLD_TILES_X`.

### Calibration (if the heat looks offset)

The `iso` projection reads its parameters (`multiply`, offsets) from the upstream
map's `extra.json`, so it should line up automatically. If you self-host tiles or
points look shifted:

- **iso:** ensure the map's `extra.json` is reachable (`…/maps/<MAP_DESC>/extra.json`); its `multiply` / `PxToTileOffset` drive placement.
- **ortho:** adjust `WORLD_TILES_X` until a known landmark's in-game `x` lines up with the map.

---

## How it works

| Piece | File | Notes |
|-------|------|-------|
| Config / build presets | `src/config.ts`, `src/builds.ts` | Env loading; per-build map + projection. |
| Log parser | `src/parser/{patterns,parse,scan}.ts` | Regex per log type; incremental read by byte offset; handles rotation. |
| Aggregator | `src/aggregate.ts` | Bins events into a grid with per-day buckets for time filtering. |
| Tile proxy | `src/tiles.ts` | Fetches + disk-caches DZI descriptor, `extra.json`, and tiles. |
| Server | `src/server.ts`, `src/index.ts` | `Bun.serve`: static app, `/api/meta`, `/api/heatmap`, `/tiles/*`; iframe-safe headers; refresh loop. |
| Frontend | `public/{index.html,app.ts,dzi-tilelayer.ts,style.css}` | Leaflet `CRS.Simple` + `leaflet.heat`; DZI tiles; category/time/radius controls; auto-refresh. |

**Coordinate projection.** The community map is *isometric*. Game tile `(x, y)` is
projected to an image pixel exactly as the map itself does it:
`px = ((x-offsetX) - (y-offsetY)) · 32 · multiply`, `py = ((x-offsetX) + (y-offsetY)) · 16 · multiply`,
then placed on Leaflet via `map.unproject`. A `pzmap2dzi` top-down render can be
used instead with `PROJECTION=ortho` (linear `px = x · pixelsPerTile`).

### API

- `GET /api/meta` → map dimensions, tile URL template, projection, available categories, event time range.
- `GET /api/heatmap?cat=pvp,map&from=<ms>&to=<ms>` → `{ binSize, points: [{x,y,weight}] }` (game-tile coords).
- `GET /tiles/<path>` → proxied + cached DZI tile/descriptor.

---

## Development

```sh
bun test            # parser, scanner, aggregator, DZI/extra parsing
bunx tsc --noEmit   # type-check
bun run dev         # build + watch-run the server
```

## Notes & caveats

- **Third-party tiles.** The default tiles come from `map.projectzomboid.com`
  (CC BY-NC-SA, © Benjamin Schieder). They're cached locally after first view.
  Respect its license; for heavy/commercial use, self-host a `pzmap2dzi` tileset
  and point `TILE_UPSTREAM`/`MAP_DESC` at it.
- **Empty corners.** The isometric map is a diamond, so corner tiles legitimately
  404 — that's expected and rendered as background.
- **Z-levels.** v1 plots all events regardless of floor/basement (`z`). A z-level
  selector could be added later.
