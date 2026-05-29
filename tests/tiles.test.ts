import { describe, expect, test } from "bun:test";
import { parseDzi, parseExtra } from "../src/tiles.ts";

describe("parseDzi", () => {
  test("parses XML descriptors", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="1" Format="png" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="4096" Height="3072"/>
</Image>`;
    expect(parseDzi(xml)).toEqual({
      tileSize: 256,
      overlap: 1,
      format: "png",
      width: 4096,
      height: 3072,
      maxLevel: 12, // ceil(log2(4096))
    });
  });

  test("parses JSON descriptors", () => {
    const json = JSON.stringify({
      Image: { TileSize: "256", Overlap: "0", Format: "jpg", Size: { Width: 1000, Height: 500 } },
    });
    expect(parseDzi(json)).toMatchObject({
      tileSize: 256,
      format: "jpg",
      width: 1000,
      height: 500,
      maxLevel: 10, // ceil(log2(1000))
    });
  });

  test("throws on a descriptor missing dimensions", () => {
    expect(() => parseDzi(`<Image TileSize="256"></Image>`)).toThrow();
  });
});

describe("parseExtra", () => {
  test("reads iso transform params from a blindcoder extra.json", () => {
    // Real shape from map.projectzomboid.com/maps/SurvivalB417812L0/extra.json
    const extra = JSON.stringify({
      multiply: 2,
      PxToTileOffset: { x: -5577, y: 10327 },
      TileToPxOffset: { x: 0, y: 0 },
    });
    expect(parseExtra(extra)).toEqual({
      multiply: 2,
      offsetX: -5577,
      offsetY: 10327,
      originX: 0,
      originY: 0,
    });
  });

  test("defaults missing fields", () => {
    expect(parseExtra("{}")).toEqual({
      multiply: 1,
      offsetX: 0,
      offsetY: 0,
      originX: 0,
      originY: 0,
    });
  });
});
