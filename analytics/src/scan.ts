import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTranscript } from './parse.ts';
import type { FileRecord } from './types.ts';

/** Bump when parse output changes shape or meaning; forces a re-parse of every transcript still on disk. */
const PARSER_VERSION = 4;

function listTranscripts(projectsDir: string): string[] {
  const out: string[] = [];
  if (!existsSync(projectsDir)) return out;
  for (const project of readdirSync(projectsDir)) {
    const pdir = join(projectsDir, project);
    let entries: string[];
    try {
      entries = readdirSync(pdir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.endsWith('.jsonl')) {
        out.push(join(pdir, name));
        continue;
      }
      const sub = join(pdir, name, 'subagents');
      if (!existsSync(sub)) continue;
      for (const f of readdirSync(sub)) if (f.endsWith('.jsonl')) out.push(join(sub, f));
    }
  }
  return out;
}

function cachePath(cacheDir: string, path: string): string {
  return join(cacheDir, createHash('sha1').update(path).digest('hex') + '.json');
}

/**
 * Parses every transcript that changed since the last run and returns all cached records,
 * including those whose transcripts Claude Code has since deleted.
 */
export function extract(
  projectsDirs: string[],
  cacheDir: string,
  log: (s: string) => void,
): FileRecord[] {
  mkdirSync(cacheDir, { recursive: true });
  const files = projectsDirs.flatMap(listTranscripts);
  let parsed = 0;
  for (const [i, path] of files.entries()) {
    const cp = cachePath(cacheDir, path);
    const st = statSync(path);
    if (existsSync(cp)) {
      try {
        const head = JSON.parse(readFileSync(cp, 'utf8'));
        if (
          head.v === PARSER_VERSION &&
          head.rec.mtimeMs === st.mtimeMs &&
          head.rec.size === st.size
        )
          continue;
      } catch {
        // Corrupt cache entry: re-parse.
      }
    }
    try {
      writeFileSync(cp, JSON.stringify({ v: PARSER_VERSION, rec: parseTranscript(path) }));
      parsed++;
    } catch (err) {
      log(`skip ${path}: ${(err as Error).message}`);
    }
    if (parsed && parsed % 200 === 0) log(`parsed ${parsed} (${i + 1}/${files.length} scanned)`);
  }
  log(`${files.length} transcripts on disk, ${parsed} parsed this run`);

  const records: FileRecord[] = [];
  for (const f of readdirSync(cacheDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      records.push(JSON.parse(readFileSync(join(cacheDir, f), 'utf8')).rec);
    } catch {
      // Ignore unreadable cache entries.
    }
  }
  return records;
}
