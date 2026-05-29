import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Aggregator } from "./aggregate.ts";
import { config } from "./config.ts";
import { scanLogs, type FileOffsets } from "./parser/scan.ts";
import { createServer, type ServerState } from "./server.ts";
import { TileProxy } from "./tiles.ts";
import type { HeatmapData } from "./types.ts";

interface PersistedState {
  offsets: FileOffsets;
  aggregate: HeatmapData;
  counts: Record<string, number>;
  lastUpdated: number;
}

const aggregator = new Aggregator(config.binSize);
const tiles = new TileProxy(config.tileUpstream, config.mapDesc, config.descriptor, config.cacheDir);
const state: ServerState = { lastUpdated: 0 };
let offsets: FileOffsets = {};

// Restore prior aggregate + read offsets so a restart resumes where it left off.
// If the bin size changed, the persisted aggregate is incompatible — drop it and
// re-scan all logs from the start.
if (existsSync(config.stateFile)) {
  try {
    const p = JSON.parse(await Bun.file(config.stateFile).text()) as PersistedState;
    if (p.aggregate?.binSize === config.binSize) {
      aggregator.load(p.aggregate, p.counts);
      offsets = p.offsets ?? {};
      state.lastUpdated = p.lastUpdated ?? 0;
    } else {
      console.warn("BIN_SIZE changed since last run — rebuilding aggregate from scratch.");
    }
  } catch (err) {
    console.warn(`Could not read state file, starting fresh: ${err}`);
  }
}

async function persist(): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  const data: PersistedState = {
    offsets,
    aggregate: aggregator.toData(),
    counts: aggregator.categoryCounts(),
    lastUpdated: state.lastUpdated,
  };
  await Bun.write(config.stateFile, JSON.stringify(data));
}

async function refresh(): Promise<void> {
  try {
    const result = await scanLogs(config.logsDir, offsets);
    if (result.events.length) aggregator.add(result.events);
    offsets = result.offsets;
    state.lastUpdated = Date.now();
    await persist();
    if (result.events.length) {
      console.log(`[${new Date().toISOString()}] +${result.events.length} events`);
    }
  } catch (err) {
    console.error("Refresh failed:", err);
  }
}

await refresh(); // initial scan before accepting requests

const server = createServer({ config, aggregator, tiles, state });
setInterval(refresh, config.refreshMinutes * 60_000);

console.log(
  `zomboid-heatmap listening on http://localhost:${server.port}\n` +
    `  logs:     ${config.logsDir}\n` +
    `  build:    ${config.build} (${config.projection} projection)\n` +
    `  tiles:    ${config.tileUpstream}maps/${config.mapDesc}/\n` +
    `  refresh:  every ${config.refreshMinutes} min`,
);
