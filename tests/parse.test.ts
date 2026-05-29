import { describe, expect, test } from "bun:test";
import { categoryFromFilename } from "../src/parser/patterns.ts";
import { parseLine } from "../src/parser/parse.ts";

describe("parseLine", () => {
  test("map placement line (Log Extender) with `at x,y,z`", () => {
    const e = parseLine(
      `[20-01-22 04:31:34.042] 76561190000000000 "outdead" taken IsoGenerator (appliances_misc_01_0) at 10883,10085,0.`,
      "map",
    );
    expect(e).not.toBeNull();
    expect(e).toMatchObject({
      category: "map",
      action: "taken",
      player: "outdead",
      steamid: "76561190000000000",
      x: 10883,
      y: 10085,
      z: 0,
    });
    expect(e!.ts).toBe(Date.UTC(2022, 0, 20, 4, 31, 34, 42));
  });

  test("cmd line with dotted action and `@ x,y,z`", () => {
    const e = parseLine(
      `[20-01-22 03:47:35.461] 76561190000000000 "outdead" campfire.light @ 10886,10087,0.`,
      "cmd",
    );
    expect(e).toMatchObject({ action: "campfire.light", x: 10886, y: 10087, z: 0 });
  });

  test("pvp line uses the attacker position and verb", () => {
    const e = parseLine(
      `[07-07-22 03:24:29.174] user outdead (8241,11669,0) hit user Rob Zombie (8242,11668,0) with Base.Hammer damage 1.735.`,
      "pvp",
    );
    expect(e).toMatchObject({ action: "hit", player: "outdead", x: 8241, y: 11669, z: 0 });
  });

  test("player death line", () => {
    const e = parseLine(
      `[10-05-26 12:00:00.000] 76561190000000000 "Bob" died at 12000,9000,0.`,
      "player",
    );
    expect(e).toMatchObject({ action: "died", player: "Bob", x: 12000, y: 9000 });
  });

  test("actor line without coordinates parses but is not plottable", () => {
    const e = parseLine(`[10-05-26 12:00:00.000] 76561190000000000 "Bob" disconnected`, "other");
    expect(e).not.toBeNull();
    expect(e).toMatchObject({ action: "disconnected", player: "Bob", x: null, y: null });
  });

  test("malformed line (no timestamp) is skipped", () => {
    expect(parseLine("this is not a log line", "map")).toBeNull();
  });

  test("timestamped line with neither actor nor coords is skipped", () => {
    expect(parseLine("[10-05-26 12:00:00.000] server tick complete", "other")).toBeNull();
  });
});

describe("categoryFromFilename", () => {
  test.each([
    ["25-05-27_12-00-00_map.txt", "map"],
    ["logs_cmd.txt", "cmd"],
    ["x_pvp.txt", "pvp"],
    ["x_vehicle.txt", "vehicle"],
    ["x_player.txt", "player"],
    ["x_admin.txt", "admin"],
    ["x_safehouse.txt", "safehouse"],
    ["x_chat.txt", "other"],
    ["25-05-27_DebugLog-server.txt", "other"],
  ])("%s -> %s", (name, expected) => {
    expect(categoryFromFilename(name)).toBe(expected);
  });
});
