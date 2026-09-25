import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig } from '../src/config';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('loadConfig', () => {
  it('returns defaults when missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-config-')); dirs.push(home);
    expect(loadConfig(home)).toMatchObject({ ...DEFAULT_CONFIG, logPath: join(home, '.jev', 'decisions.jsonl') });
  });

  it('merges overrides and renames corrupt config', () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-config-')); dirs.push(home);
    mkdirSync(join(home, '.jev'));
    writeFileSync(join(home, '.jev', 'config.json'), JSON.stringify({ timeoutMs: 123, thresholds: { denyRisk: 3 } }));
    expect(loadConfig(home)).toMatchObject({ timeoutMs: 123, thresholds: { denyRisk: 3, askRisk: 1.5 } });
    writeFileSync(join(home, '.jev', 'config.json'), '{bad');
    loadConfig(home);
    expect(existsSync(join(home, '.jev', 'config.json.bad'))).toBe(true);
  });
});
