import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";

// Proxies a Deep Zoom Image (DZI) pyramid from an upstream community map and
// caches it to disk. Using a proxy avoids browser CORS issues and means tiles
// are fetched once.
//
// Verified layout (map.projectzomboid.com / blindcoder), relative to the host:
//   maps/<desc>/<descriptor>         e.g. maps/SurvivalB417812L0/map.xml
//   maps/<desc>/extra.json           isometric transform params
//   maps/<desc>/<base>_files/{level}/{col}_{row}.{format}   (base = descriptor sans ext)
// DZI level `maxLevel` is full resolution; each lower level halves dimensions.

export interface DziInfo {
  tileSize: number;
  overlap: number;
  format: string;
  width: number;
  height: number;
  /** Highest (full-resolution) DZI level. */
  maxLevel: number;
}

/** Isometric transform params (from the map's extra.json). */
export interface IsoParams {
  multiply: number;
  offsetX: number; // PxToTileOffset.x
  offsetY: number; // PxToTileOffset.y
  originX: number; // TileToPxOffset.x
  originY: number; // TileToPxOffset.y
}

function attr(xml: string, name: string): string | undefined {
  return new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(xml)?.[1];
}

/** Parse a DZI descriptor in either XML or JSON form. */
export function parseDzi(text: string): DziInfo {
  let tileSize: number, overlap: number, format: string, width: number, height: number;

  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    const img = JSON.parse(trimmed).Image ?? {};
    tileSize = +img.TileSize;
    overlap = +img.Overlap;
    format = String(img.Format ?? "png");
    width = +img.Size?.Width;
    height = +img.Size?.Height;
  } else {
    tileSize = +(attr(text, "TileSize") ?? NaN);
    overlap = +(attr(text, "Overlap") ?? 0);
    format = attr(text, "Format") ?? "png";
    width = +(attr(text, "Width") ?? NaN);
    height = +(attr(text, "Height") ?? NaN);
  }

  if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(tileSize)) {
    throw new Error("Could not parse DZI descriptor (missing Width/Height/TileSize)");
  }
  const maxLevel = Math.ceil(Math.log2(Math.max(width, height)));
  return { tileSize, overlap, format, width, height, maxLevel };
}

/** Parse a blindcoder-style extra.json into iso transform params. */
export function parseExtra(text: string): IsoParams {
  const e = JSON.parse(text);
  return {
    multiply: +(e.multiply ?? 1),
    offsetX: +(e.PxToTileOffset?.x ?? 0),
    offsetY: +(e.PxToTileOffset?.y ?? 0),
    originX: +(e.TileToPxOffset?.x ?? 0),
    originY: +(e.TileToPxOffset?.y ?? 0),
  };
}

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

function contentTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export class TileProxy {
  private descriptor: DziInfo | null = null;
  private iso: IsoParams | null = null;

  /** Path of the map folder relative to the upstream host, e.g. "maps/<desc>/". */
  readonly mapPath: string;
  /** Descriptor base name (descriptor sans extension), e.g. "map". */
  readonly base: string;

  constructor(
    private readonly upstream: string,
    mapDesc: string,
    private readonly descriptorFile: string,
    private readonly cacheDir: string,
  ) {
    this.mapPath = `maps/${mapDesc}/`;
    this.base = descriptorFile.replace(/\.[^.]+$/, "");
  }

  /** Relative path of the tiles directory under the upstream host. */
  get tilesDir(): string {
    return `${this.mapPath}${this.base}_files`;
  }

  /** Fetch + parse + cache the DZI descriptor (memoized in memory + on disk). */
  async getDescriptor(): Promise<DziInfo> {
    if (this.descriptor) return this.descriptor;
    return (this.descriptor = parseDzi(await this.fetchText(this.mapPath + this.descriptorFile)));
  }

  /** Fetch the isometric transform params from extra.json, or null if absent. */
  async getIsoParams(): Promise<IsoParams | null> {
    if (this.iso) return this.iso;
    try {
      return (this.iso = parseExtra(await this.fetchText(`${this.mapPath}extra.json`)));
    } catch {
      return null; // some sources (e.g. plain pzmap2dzi) have no extra.json
    }
  }

  /**
   * Serve a tile (or other asset) by its path relative to the upstream host.
   * Returns cached bytes when present, otherwise fetches + caches. Returns null
   * on a non-OK upstream response (e.g. an empty iso-diamond corner tile).
   */
  async getTile(relPath: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    // Prevent path traversal: the resolved path must stay inside the cache dir.
    const safeRel = normalize(relPath).replace(/^(\.\.[/\\])+/, "");
    const cachePath = join(this.cacheDir, safeRel);
    if (!cachePath.startsWith(this.cacheDir)) return null;

    const contentType = contentTypeFor(safeRel);
    if (existsSync(cachePath)) {
      return { bytes: await Bun.file(cachePath).bytes(), contentType };
    }
    const res = await fetch(this.upstream + safeRel);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    await this.writeCache(cachePath, bytes);
    return { bytes, contentType };
  }

  private async fetchText(rel: string): Promise<string> {
    const cachePath = join(this.cacheDir, rel);
    if (existsSync(cachePath)) return Bun.file(cachePath).text();
    const res = await fetch(this.upstream + rel);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch ${this.upstream + rel} (HTTP ${res.status}). ` +
          `Check TILE_UPSTREAM / MAP_DESC / MAP_DESCRIPTOR.`,
      );
    }
    const text = await res.text();
    await this.writeCache(cachePath, new TextEncoder().encode(text));
    return text;
  }

  private async writeCache(path: string, bytes: Uint8Array): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, bytes);
  }
}
