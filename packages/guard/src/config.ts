import { existsSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_THRESHOLDS, type Thresholds } from 'jev-core';

export interface GuardConfig {
  enabled: boolean;
  thresholds: Thresholds;
  prefilterTools: string[];
  timeoutMs: number;
  logPath: string;
  debug: boolean;
}

export const DEFAULT_CONFIG: GuardConfig = {
  enabled: true,
  thresholds: { ...DEFAULT_THRESHOLDS },
  prefilterTools: ['list_dir', 'view_file', 'read_file', 'Read', 'Glob', 'Grep', 'codebase_search', 'view_code_item', 'read_url_content'],
  timeoutMs: 3000,
  logPath: '~/.jev/decisions.jsonl',
  debug: false,
};

function expandHome(value: string, homeDir: string): string {
  return value.replace(/^~(?=$|[\\/])/, homeDir);
}

export function loadConfig(homeDir = homedir()): GuardConfig {
  const path = join(homeDir, '.jev', 'config.json');
  if (!existsSync(path)) {
    return { ...DEFAULT_CONFIG, thresholds: { ...DEFAULT_THRESHOLDS }, logPath: join(homeDir, '.jev', 'decisions.jsonl') };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<GuardConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      thresholds: { ...DEFAULT_THRESHOLDS, ...(parsed.thresholds ?? {}) },
      prefilterTools: parsed.prefilterTools ?? DEFAULT_CONFIG.prefilterTools,
      logPath: expandHome(typeof parsed.logPath === 'string' ? parsed.logPath : DEFAULT_CONFIG.logPath, homeDir),
    };
  } catch {
    try { renameSync(path, path + '.bad'); } catch { /* best effort */ }
    return { ...DEFAULT_CONFIG, thresholds: { ...DEFAULT_THRESHOLDS }, logPath: join(homeDir, '.jev', 'decisions.jsonl') };
  }
}
