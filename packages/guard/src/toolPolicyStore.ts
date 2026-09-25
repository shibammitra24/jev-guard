import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mergeToolPolicyState, type ToolPolicyState } from 'jev-core';

export function toolPolicyPath(homeDir = homedir()): string {
  return join(homeDir, '.jev', 'tool-policy.json');
}

/** Reads the Guard Console's allow/deny toggles, merged onto the current catalog defaults. */
export function loadToolPolicy(homeDir = homedir()): ToolPolicyState {
  const path = toolPolicyPath(homeDir);
  if (!existsSync(path)) return mergeToolPolicyState(undefined);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ToolPolicyState>;
    return mergeToolPolicyState(parsed);
  } catch {
    try { renameSync(path, path + '.bad'); } catch { /* best effort */ }
    return mergeToolPolicyState(undefined);
  }
}

/** Persists a full toggle state written by the Guard Console. */
export function saveToolPolicy(state: ToolPolicyState, homeDir = homedir()): void {
  const path = toolPolicyPath(homeDir);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}
