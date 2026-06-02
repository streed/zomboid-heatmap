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

  test("strips a `[LEVEL]` tag emitted after the timestamp by newer builds", () => {
    const e = parseLine(
      `[02-06-26 03:35:11.174][INFO] 76561197979998632 "zeke" removed IsoObject (appliances_refrigeration_01_28) at 8209,11599,0.`,
      "map",
    );
    expect(e).toMatchObject({ action: "removed", player: "zeke", x: 8209, y: 11599, z: 0 });
  });

  test("verbose player line keeps the trailing position, not numbers from the JSON", () => {
    const e = parseLine(
      `[02-06-26 03:20:56.785] 76561197976256598 "elchupa" tick perks={"Aiming":0,"Axe":5} ` +
        `stats={"profession":"lumberjack","kills":11,"hours":6.76} ` +
        `safehouse owner=(8116x11537 - 8146x11564) (8133,11567,0).`,
      "player",
    );
    expect(e).toMatchObject({ action: "tick", player: "elchupa", x: 8133, y: 11567, z: 0 });
  });

  test("player connect line extracts metrics into `details`", () => {
    const e = parseLine(
      `[02-06-26 03:17:06.529] 76561197976256598 "elchupa" connected ` +
        `perks={"Axe":5,"Strength":10} traits=["Fit","Strong"] ` +
        `stats={"profession":"lumberjack","kills":2,"hours":6} ` +
        `health={"health":100,"infected":false} ` +
        `safehouse owner=(8116x11537 - 8146x11564) (8140,11549,1).`,
      "player",
    );
    expect(e).toMatchObject({ action: "connected", x: 8140, y: 11549, z: 1 });
    expect(e!.details).toEqual({
      profession: "lumberjack",
      kills: 2,
      hours: 6,
      health: 100,
      infected: false,
      perks: { Axe: 5, Strength: 10 },
      traits: ["Fit", "Strong"],
    });
  });

  test("map line carries no player `details`", () => {
    const e = parseLine(
      `[02-06-26 03:35:11.174] 76561197979998632 "zeke" removed IsoObject (x_1) at 8209,11599,0.`,
      "map",
    );
    expect(e!.details).toBeUndefined();
  });

  test("coordinate-less `restore safety` pvp line is skipped", () => {
    const e = parseLine(
      `[02-06-26 03:17:04.126][INFO] user "elchupa" restore safety enabled=true last=true cooldown=0.0 toggle=0.0.`,
      "pvp",
    );
    expect(e).toBeNull();
  });

  test("PerkLog [Died] line becomes a player death with hours survived", () => {
    const e = parseLine(
      `[02-06-26 03:22:46.291] [76561197976256598][elchupa][8188,11563,0][Died][Hours Survived: 7].`,
      "player",
    );
    expect(e).toMatchObject({
      category: "player",
      action: "died",
      steamid: "76561197976256598",
      player: "elchupa",
      x: 8188,
      y: 11563,
      z: 0,
    });
    expect(e!.details?.hours).toBe(7);
  });

  test("PerkLog [Login] / skill-dump lines are dropped (not deaths)", () => {
    expect(
      parseLine(
        `[02-06-26 03:17:06.529] [76561197976256598][elchupa][8140,11549,1][Login][Hours Survived: 6].`,
        "player",
      ),
    ).toBeNull();
    expect(
      parseLine(
        `[02-06-26 03:17:06.529] [76561197976256598][elchupa][8140,11549,1][Cooking=0, Axe=5][Hours Survived: 6].`,
        "player",
      ),
    ).toBeNull();
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
    ["x_PerkLog.txt", "player"], // deaths fold into player data
  ])("%s -> %s", (name, expected) => {
    expect(categoryFromFilename(name)).toBe(expected);
  });

  // Non-spatial / noisy logs are not ingested (null so scan skips them).
  test.each([
    ["x_chat.txt"],
    ["25-05-27_DebugLog-server.txt"],
    ["x_item.txt"],
    ["x_craft.txt"],
    ["x_user.txt"],
    ["x_ClientActionLog.txt"],
  ])("%s -> null (skipped)", (name) => {
    expect(categoryFromFilename(name)).toBeNull();
  });
});
