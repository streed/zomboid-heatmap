import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Aggregator } from "./aggregate.ts";
import { config } from "./config.ts";
import { scanLogs, type FileOffsets } from "./parser/scan.ts";
import { PlayerTracker } from "./players.ts";
import { createServer, type ServerState } from "./server.ts";
import { TileProxy } from "./tiles.ts";
import type { HeatmapData } from "./types.ts";

interface PersistedState {
  offsets: FileOffsets;
  aggregate: HeatmapData;
  counts: Record<string, number>;
  lastUpdated: number;
}

// Backfill: ignore any saved offsets/aggregate and re-ingest every log file
// from the beginning, rebuilding the heatmap from scratch. Triggered by
// `bun run backfill` (sets BACKFILL=1) or a `--backfill` flag. Useful after a
// log-format change, a parser fix, or when wiring the heatmap onto a server
// that already has historical logs.
const backfill =
  process.argv.includes("--backfill") ||
  ["1", "true", "yes"].includes((process.env.BACKFILL ?? "").toLowerCase());

const aggregator = new Aggregator(config.binSize);
const players = new PlayerTracker(config.dbFile, config.playerStaleMs, config.binSize);
const tiles = new TileProxy(config.tileUpstream, config.mapDesc, config.descriptor, config.cacheDir);
const state: ServerState = { lastUpdated: 0 };
let offsets: FileOffsets = {};

// Restore prior aggregate + read offsets so a restart resumes where it left off.
// If the bin size changed, the persisted aggregate is incompatible — drop it and
// re-scan all logs from the start. Backfill skips restore entirely.
if (backfill) {
  console.log("BACKFILL requested — re-scanning all logs from the start.");
  players.reset(); // rebuild the player table from scratch alongside the aggregate
} else if (existsSync(config.stateFile)) {
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
    if (result.events.length) {
      aggregator.add(result.events);
      players.update(result.events); // SQLite-backed; persists itself
    }
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

// Backfill is a one-shot: the scan above already rebuilt and persisted
// state.json from every log, so exit instead of binding the port (which would
// collide with the running service). Restart the service to load the new state.
if (backfill) {
  console.log(
    `Backfill complete — rebuilt ${config.stateFile} and ${config.dbFile} ` +
      `(${players.count()} players). ` +
      `Restart the service to load it (e.g. systemctl restart zomboid-heatmap).`,
  );
  process.exit(0);
}

const server = createServer({ config, aggregator, players, tiles, state });
setInterval(refresh, config.refreshMinutes * 60_000);

console.log(
  `zomboid-heatmap listening on http://${config.hostname}:${server.port}\n` +
    `  logs:     ${config.logsDir}\n` +
    `  build:    ${config.build} (${config.projection} projection)\n` +
    `  tiles:    ${config.tileUpstream}maps/${config.mapDesc}/\n` +
    `  refresh:  every ${config.refreshMinutes} min`,
);
