import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanLogs } from "../src/parser/scan.ts";

const dir = await mkdtemp(join(tmpdir(), "pzhm-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

const L1 = `[10-05-26 12:00:00.000] 1234567890 "Alice" built Wall at 100,200,0.\n`;
const L2 = `[10-05-26 12:01:00.000] 1234567890 "Alice" taken Door at 101,201,0.\n`;
const L3 = `[10-05-26 12:02:00.000] 1234567890 "Alice" dropped Bag at 102,202,0.\n`;

describe("scanLogs (incremental)", () => {
  const file = join(dir, "25-05-27_12-00-00_map.txt");

  test("reads new files and resolves category from the filename", async () => {
    await writeFile(file, L1 + L2);
    const first = await scanLogs(dir, {});
    expect(first.events).toHaveLength(2);
    expect(first.events[0]).toMatchObject({ category: "map", action: "built", x: 100 });
  });

  test("only reads appended bytes on the next scan", async () => {
    const first = await scanLogs(dir, {});
    await writeFile(file, L1 + L2 + L3);
    const second = await scanLogs(dir, first.offsets);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toMatchObject({ action: "dropped", x: 102 });
  });

  test("does not emit a trailing partial line until it is completed", async () => {
    const partialFile = join(dir, "partial_cmd.txt");
    await writeFile(partialFile, L1 + `[10-05-26 12:03:00.000] 123456 "A" generator.tog`); // no newline
    const a = await scanLogs(dir, {});
    const fromPartial = a.events.filter((e) => e.category === "cmd");
    expect(fromPartial).toHaveLength(1); // only the completed first line

    await writeFile(partialFile, L1 + `[10-05-26 12:03:00.000] 123456 "A" generator.toggle @ 5,6,0.\n`);
    const b = await scanLogs(dir, a.offsets);
    const newCmd = b.events.filter((e) => e.category === "cmd");
    expect(newCmd).toHaveLength(1);
    expect(newCmd[0]).toMatchObject({ action: "generator.toggle", x: 5 });
  });

  test("resets offset when a file shrinks (rotation/truncation)", async () => {
    const rotFile = join(dir, "rot_player.txt");
    await writeFile(rotFile, L1 + L2);
    const a = await scanLogs(dir, {});
    const offsetForRot = a.offsets[rotFile]!;
    expect(offsetForRot).toBeGreaterThan(0);

    await writeFile(rotFile, L3); // rotated: smaller file
    const b = await scanLogs(dir, a.offsets);
    const rotated = b.events.filter((e) => e.category === "player");
    expect(rotated).toHaveLength(1);
    expect(rotated[0]).toMatchObject({ action: "dropped", x: 102 });
  });
});
