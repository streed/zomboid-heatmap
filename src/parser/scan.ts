import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { GameEvent } from "../types.ts";
import { categoryFromFilename } from "./patterns.ts";
import { parseLine } from "./parse.ts";

/** Byte offset already consumed, keyed by absolute file path. */
export type FileOffsets = Record<string, number>;

export interface ScanResult {
  events: GameEvent[];
  offsets: FileOffsets;
}

/** Recursively collect `*.txt` log files under `dir` (handles dated subfolders). */
async function findLogFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // dir missing or unreadable — treated as "no logs yet"
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findLogFiles(full)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".txt")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Scan the logs directory for new content since the last scan.
 *
 * Reads only the bytes appended past each file's stored offset, so repeated
 * scans are cheap. Stops at the last complete line (a final partial line is
 * left for the next scan). Resets a file's offset to 0 if it shrank, which
 * covers log rotation / truncation.
 */
export async function scanLogs(
  logsDir: string,
  prior: FileOffsets,
): Promise<ScanResult> {
  const events: GameEvent[] = [];
  const offsets: FileOffsets = {};

  for (const path of await findLogFiles(logsDir)) {
    const file = Bun.file(path);
    const size = file.size;
    let offset = prior[path] ?? 0;
    if (size < offset) offset = 0; // rotated or truncated
    if (size === offset) {
      offsets[path] = offset; // unchanged
      continue;
    }

    const chunk = await file.slice(offset, size).text();
    const lastNl = chunk.lastIndexOf("\n");
    if (lastNl === -1) {
      // No complete line yet; leave the offset so we retry next scan.
      offsets[path] = offset;
      continue;
    }

    const complete = chunk.slice(0, lastNl + 1);
    const category = categoryFromFilename(path);
    for (const line of complete.split("\n")) {
      if (!line) continue;
      const event = parseLine(line, category);
      if (event) events.push(event);
    }

    offsets[path] = offset + Buffer.byteLength(complete, "utf8");
  }

  return { events, offsets };
}
