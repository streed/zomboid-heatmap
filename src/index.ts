import { Aggregator } from "./aggregate.ts";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { scanLogs, type FileOffsets } from "./parser/scan.ts";
import { PlayerTracker } from "./players.ts";
import { createServer, type ServerState } from "./server.ts";
import { StateStore } from "./state.ts";
import { TileProxy } from "./tiles.ts";

// Backfill: ignore any saved offsets/aggregate and re-ingest every log file
// from the beginning, rebuilding the heatmap from scratch. Triggered by
// `bun run backfill` (sets BACKFILL=1) or a `--backfill` flag. Useful after a
// log-format change, a parser fix, or when wiring the heatmap onto a server
// that already has historical logs.
const backfill =
  process.argv.includes("--backfill") ||
  ["1", "true", "yes"].includes((process.env.BACKFILL ?? "").toLowerCase());

// One SQLite DB now holds everything: player tracking, scan offsets, and the
// heatmap aggregate (which used to live in data/state.json). Open it once and
// share the handle so there's a single writer and no cross-connection locking.
const db = openDb(config.dbFile);
const store = new StateStore(db, config.binSize);
const aggregator = new Aggregator(config.binSize);
const players = new PlayerTracker(db, config.playerStaleMs, config.binSize);
const tiles = new TileProxy(config.tileUpstream, config.mapDesc, config.descriptor, config.cacheDir);
const state: ServerState = { lastUpdated: 0 };
let offsets: FileOffsets = {};

// Restore prior aggregate + offsets so a restart resumes where it left off.
// (StateStore drops incompatible bins itself if BIN_SIZE changed.) Backfill
// skips restore entirely and wipes the persisted state for a clean re-scan.
if (backfill) {
  console.log("BACKFILL requested — re-scanning all logs from the start.");
  store.reset();
  players.reset(); // rebuild the player table from scratch alongside the aggregate
} else {
  const restored = store.loadAggregate();
  aggregator.load(restored.data, restored.counts);
  offsets = store.loadOffsets();
  state.lastUpdated = store.lastUpdated();
}

function persist(): void {
  store.save(offsets, aggregator.toData(), aggregator.categoryCounts(), state.lastUpdated);
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
    persist();
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
    `Backfill complete — rebuilt ${config.dbFile} ` +
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
