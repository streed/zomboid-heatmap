import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Aggregator } from "./aggregate.ts";
import type { Config } from "./config.ts";
import type { TileProxy } from "./tiles.ts";
import type { MapMeta, Projection } from "./types.ts";

const ROOT = join(import.meta.dir, "..");

/** Mutable runtime state shared with the refresh loop. */
export interface ServerState {
  lastUpdated: number;
}

export interface ServerDeps {
  config: Config;
  aggregator: Aggregator;
  tiles: TileProxy;
  state: ServerState;
}

// Static files served by simple routes. Leaflet's CSS is served straight from
// node_modules; its JS is bundled into dist/app.js by `bun build`.
const STATIC: Record<string, { path: string; type: string }> = {
  "/": { path: join(ROOT, "public/index.html"), type: "text/html; charset=utf-8" },
  "/style.css": { path: join(ROOT, "public/style.css"), type: "text/css; charset=utf-8" },
  "/app.js": { path: join(ROOT, "dist/app.js"), type: "text/javascript; charset=utf-8" },
  "/vendor/leaflet.css": {
    path: join(ROOT, "node_modules/leaflet/dist/leaflet.css"),
    type: "text/css; charset=utf-8",
  },
};

function json(data: unknown, headers: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    headers: { ...headers, "content-type": "application/json; charset=utf-8" },
  });
}

export function createServer(deps: ServerDeps) {
  const { config, aggregator, tiles, state } = deps;

  // Applied to every response so the app can be embedded per FRAME_ANCESTORS.
  // We intentionally do NOT send X-Frame-Options (it can't express an allowlist).
  const baseHeaders: Record<string, string> = {
    "content-security-policy": `frame-ancestors ${config.frameAncestors}`,
  };

  async function buildProjection(imageWidth: number): Promise<Projection> {
    if (config.projection === "iso") {
      const iso = await tiles.getIsoParams();
      if (iso) return { mode: "iso", ...iso };
      throw new Error(
        `PROJECTION=iso but no usable extra.json at ${config.tileUpstream}${tiles.mapPath}extra.json. ` +
          `Set PROJECTION=ortho, or point MAP_DESC at a blindcoder-style map.`,
      );
    }
    return { mode: "ortho", pixelsPerTile: imageWidth / config.worldTilesX };
  }

  async function buildMeta(): Promise<MapMeta> {
    const dzi = await tiles.getDescriptor();
    const range = aggregator.range();
    return {
      build: config.build,
      imageWidth: dzi.width,
      imageHeight: dzi.height,
      tileSize: dzi.tileSize,
      overlap: dzi.overlap,
      maxLevel: dzi.maxLevel,
      format: dzi.format,
      tileUrlTemplate: `/tiles/${tiles.tilesDir}/{z}/{x}_{y}.${dzi.format}`,
      projection: await buildProjection(dzi.width),
      available: aggregator.categoryCounts(),
      eventsFrom: range?.from ?? null,
      eventsTo: range?.to ?? null,
      lastUpdated: state.lastUpdated,
    };
  }

  return Bun.serve({
    port: config.port,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;

      // Static assets.
      const asset = STATIC[path];
      if (asset) {
        if (!existsSync(asset.path)) {
          return new Response(`Missing asset: ${path}. Did you run \`bun run build\`?`, {
            status: 404,
            headers: baseHeaders,
          });
        }
        return new Response(Bun.file(asset.path), {
          headers: { ...baseHeaders, "content-type": asset.type },
        });
      }

      // Map metadata (dimensions, projection scale, available categories).
      if (path === "/api/meta") {
        try {
          return json(await buildMeta(), { ...baseHeaders, "cache-control": "no-cache" });
        } catch (err) {
          return json(
            { error: String(err instanceof Error ? err.message : err) },
            { ...baseHeaders, "cache-control": "no-cache" },
          );
        }
      }

      // Heatmap points, filtered by category list + optional time range.
      if (path === "/api/heatmap") {
        const cat = url.searchParams.get("cat");
        const categories = cat ? cat.split(",").filter(Boolean) : undefined;
        const fromRaw = url.searchParams.get("from");
        const toRaw = url.searchParams.get("to");
        const points = aggregator.query({
          categories,
          from: fromRaw ? Number(fromRaw) : undefined,
          to: toRaw ? Number(toRaw) : undefined,
        });
        return json(
          { binSize: config.binSize, points },
          { ...baseHeaders, "cache-control": "no-cache" },
        );
      }

      // DZI tiles + descriptor, proxied & cached.
      if (path.startsWith("/tiles/")) {
        const rel = decodeURIComponent(path.slice("/tiles/".length));
        const tile = await tiles.getTile(rel);
        if (!tile) return new Response("Not found", { status: 404, headers: baseHeaders });
        return new Response(tile.bytes as BodyInit, {
          headers: {
            ...baseHeaders,
            "content-type": tile.contentType,
            "cache-control": "public, max-age=604800, immutable",
          },
        });
      }

      return new Response("Not found", { status: 404, headers: baseHeaders });
    },
  });
}
