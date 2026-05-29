// Per-build presets describing which community map to proxy and how its
// coordinates project. Verified against map.projectzomboid.com (blindcoder's
// classic map), which is isometric and serves DZI tiles at
//   maps/<desc>/map.xml                     (descriptor)
//   maps/<desc>/extra.json                  (iso transform params)
//   maps/<desc>/map_files/{level}/{col}_{row}.jpg
//
// The isometric transform params (multiply + offsets) are read at runtime from
// the map's extra.json, so they don't need to be hardcoded here.

export type ProjectionMode = "iso" | "ortho";

export interface BuildPreset {
  /** Upstream base URL (host), e.g. "https://map.projectzomboid.com/". */
  tileUpstream: string;
  /** Map descriptor folder under `maps/`, e.g. "SurvivalB417812L0". */
  mapDesc: string;
  /** DZI descriptor filename within the map folder. */
  descriptor: string;
  /** Coordinate projection of the chosen render. */
  projection: ProjectionMode;
  /** Only used for `ortho`: approximate world width in tiles -> pixelsPerTile. */
  worldTilesX: number;
}

export const BUILDS: Record<number, BuildPreset> = {
  41: {
    tileUpstream: "https://map.projectzomboid.com/",
    mapDesc: "SurvivalB417812L0",
    descriptor: "map.xml",
    projection: "iso",
    worldTilesX: 15300,
  },
  42: {
    // B42 community map. Defaults are a starting point — verify mapDesc against
    // the upstream you point at (see README "Targeting Build 42").
    tileUpstream: "https://b42map.com/",
    mapDesc: "SurvivalB42L0",
    descriptor: "map.xml",
    projection: "iso",
    worldTilesX: 22000,
  },
};

export function getBuildPreset(build: number): BuildPreset {
  const preset = BUILDS[build];
  if (!preset) {
    throw new Error(
      `Unknown BUILD=${build}. Supported: ${Object.keys(BUILDS).join(", ")}. ` +
        `Override TILE_UPSTREAM / MAP_DESC / PROJECTION via .env if needed.`,
    );
  }
  return preset;
}
