import L from "leaflet";
import type { MapMeta } from "../src/types.ts";

// A Leaflet TileLayer that reads a Deep Zoom (DZI) pyramid through our /tiles
// proxy. We configure the map so that Leaflet zoom == DZI level, so Leaflet's
// own {z}/{x}/{y} substitution maps directly onto the DZI tile path (the map
// uses `{x}_{y}` with an underscore, supplied via meta.tileUrlTemplate).

/** Smallest DZI level whose largest dimension still fits within one tile. */
export function minLevelFor(meta: MapMeta): number {
  const maxDim = Math.max(meta.imageWidth, meta.imageHeight);
  return Math.max(0, meta.maxLevel - Math.ceil(Math.log2(maxDim / meta.tileSize)));
}

type SizedTile = HTMLImageElement & { _dziSize?: [number, number] };

export function createDziLayer(meta: MapMeta, bounds: L.LatLngBounds): L.TileLayer {
  // DZI tiles are NOT all tileSize x tileSize: at low levels the whole image is
  // a single small tile, and the right/bottom edge tiles are partial. Leaflet
  // stretches every tile to a full tileSize square, which distorts those — most
  // visibly when zoomed out, where the isometric map collapses into a flattened,
  // top-down-looking shape. So we size each tile to its true pixel dimensions.
  const trueTileSize = (coords: L.Coords): [number, number] => {
    const scale = 2 ** (meta.maxLevel - coords.z); // coords.z == DZI level
    const levelW = Math.ceil(meta.imageWidth / scale);
    const levelH = Math.ceil(meta.imageHeight / scale);
    const ts = meta.tileSize;
    return [
      Math.max(0, Math.min(ts, levelW - coords.x * ts)),
      Math.max(0, Math.min(ts, levelH - coords.y * ts)),
    ];
  };

  // createTile / _initTile are protected/internal in @types/leaflet, so reach
  // the prototype methods through `any`.
  const proto = L.TileLayer.prototype as any;
  const DziTileLayer = L.TileLayer.extend({
    createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
      const tile = proto.createTile.call(this, coords, done) as SizedTile;
      tile._dziSize = trueTileSize(coords); // applied in _initTile (runs after this)
      return tile;
    },
    _initTile(tile: SizedTile): void {
      proto._initTile.call(this, tile); // sets size to tileSize...
      if (tile._dziSize) {
        // ...override for partial tiles so they aren't stretched.
        tile.style.width = `${tile._dziSize[0]}px`;
        tile.style.height = `${tile._dziSize[1]}px`;
      }
    },
  }) as unknown as new (url: string, options: L.TileLayerOptions) => L.TileLayer;

  return new DziTileLayer(meta.tileUrlTemplate, {
    tileSize: meta.tileSize,
    minNativeZoom: minLevelFor(meta),
    maxNativeZoom: meta.maxLevel,
    minZoom: minLevelFor(meta),
    maxZoom: meta.maxLevel,
    bounds, // don't request tiles outside the image
    noWrap: true,
    className: "dzi-tiles",
  });
}
