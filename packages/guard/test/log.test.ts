import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/log';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('decision logger', () => {
  it('appends JSONL and tails records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-log-')); dirs.push(dir);
    const logger = createLogger(join(dir, 'nested', 'decisions.jsonl'));
    logger.append({ tool: 'run_command', verdict: 'deny' });
    logger.append({ tool: 'view_file', verdict: 'allow' });
    expect(logger.tail(1)).toEqual([{ tool: 'view_file', verdict: 'allow' }]);
    expect(readFileSync(join(dir, 'nested', 'decisions.jsonl'), 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('rotates an oversized file before appending', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-log-')); dirs.push(dir);
    const path = join(dir, 'decisions.jsonl');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, 'x'.repeat(20 * 1024 * 1024 + 1));
    createLogger(path).append({ ok: true });
    expect(readFileSync(join(dir, 'decisions.1.jsonl'), 'utf8').length).toBeGreaterThan(20 * 1024 * 1024);
  });
});
