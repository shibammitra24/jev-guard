import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultToolPolicyState } from 'jev-core';
import { loadToolPolicy, saveToolPolicy, toolPolicyPath } from '../src/toolPolicyStore';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('loadToolPolicy', () => {
  it('returns catalog defaults when no file exists', () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-toolpolicy-')); dirs.push(home);
    expect(loadToolPolicy(home)).toEqual(defaultToolPolicyState());
  });

  it('merges a saved override onto the defaults', () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-toolpolicy-')); dirs.push(home);
    mkdirSync(join(home, '.jev'));
    writeFileSync(join(home, '.jev', 'tool-policy.json'), JSON.stringify({ op_destructive: true }));
    const state = loadToolPolicy(home);
    expect(state.op_destructive).toBe(true);
    expect(state.tool_read).toBe(true);
  });

  it('renames a corrupt file and falls back to defaults', () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-toolpolicy-')); dirs.push(home);
    mkdirSync(join(home, '.jev'));
    writeFileSync(join(home, '.jev', 'tool-policy.json'), '{not json');
    expect(loadToolPolicy(home)).toEqual(defaultToolPolicyState());
    expect(existsSync(join(home, '.jev', 'tool-policy.json.bad'))).toBe(true);
  });
});

describe('saveToolPolicy', () => {
  it('writes a state that loadToolPolicy reads back unchanged', () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-toolpolicy-')); dirs.push(home);
    const state = { ...defaultToolPolicyState(), op_destructive: true, tool_run_command: false };
    saveToolPolicy(state, home);
    expect(existsSync(toolPolicyPath(home))).toBe(true);
    expect(loadToolPolicy(home)).toEqual(state);
  });

  it('creates the ~/.jev directory if missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-toolpolicy-')); dirs.push(home);
    saveToolPolicy(defaultToolPolicyState(), home);
    expect(existsSync(join(home, '.jev'))).toBe(true);
  });

  it('writes valid indented JSON', () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-toolpolicy-')); dirs.push(home);
    saveToolPolicy(defaultToolPolicyState(), home);
    const raw = readFileSync(toolPolicyPath(home), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw).toContain('\n');
  });
});
