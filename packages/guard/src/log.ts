import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, watch as fsWatch } from 'node:fs';
import { dirname } from 'node:path';

export interface DecisionLogger {
  append(record: unknown): void;
  tail(count: number): unknown[];
  watch(callback: (record: unknown) => void): () => void;
}

const MAX_BYTES = 20 * 1024 * 1024;

function readLines(filePath: string): unknown[] {
  return readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function createLogger(filePath: string): DecisionLogger {
  const ensureParent = () => mkdirSync(dirname(filePath), { recursive: true });
  const append = (record: unknown) => {
    try {
      ensureParent();
      if (existsSync(filePath) && statSync(filePath).size > MAX_BYTES) {
        try { renameSync(filePath, filePath.replace(/\.jsonl$/, '.1.jsonl')); } catch { /* best effort */ }
      }
      appendFileSync(filePath, JSON.stringify(record) + '\n', { encoding: 'utf8', flag: 'a' });
    } catch {
      // Logging is deliberately non-blocking and non-fatal.
    }
  };
  const tail = (count: number) => {
    try {
      if (!existsSync(filePath)) return [];
      return count > 0 ? readLines(filePath).slice(-count) : [];
    } catch { return []; }
  };
  const watch = (callback: (record: unknown) => void) => {
    try {
      ensureParent();
      let offset = existsSync(filePath) ? statSync(filePath).size : 0;
      const watcher = fsWatch(dirname(filePath), (_event, name) => {
        if (name !== filePath.split(/[\\/]/).pop()) return;
        try {
          if (!existsSync(filePath)) { offset = 0; return; }
          const text = readFileSync(filePath, 'utf8');
          const bytes = Buffer.byteLength(text, 'utf8');
          if (bytes < offset) offset = 0;
          const appended = Buffer.from(text, 'utf8').subarray(offset).toString('utf8');
          offset = bytes;
          for (const line of appended.split(/\r?\n/).filter(Boolean)) {
            try { callback(JSON.parse(line)); } catch { /* ignore partial/malformed lines */ }
          }
        } catch {
          // Watching is best effort.
        }
      });
      return () => watcher.close();
    } catch { return () => undefined; }
  };
  return { append, tail, watch };
}
