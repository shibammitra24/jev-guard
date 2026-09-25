import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadApiKey } from '../src/credentials';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('loadApiKey', () => {
  it('prefers the environment', () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-credentials-')); dirs.push(home);
    mkdirSync(join(home, '.jev'));
    writeFileSync(join(home, '.jev', 'credentials'), 'TYPESAFE_API_KEY=file-key');
    expect(loadApiKey({ TYPESAFE_API_KEY: ' env-key ' }, home)).toBe('env-key');
  });

  it('reads the credentials file and fails when absent', () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-credentials-')); dirs.push(home);
    mkdirSync(join(home, '.jev'));
    writeFileSync(join(home, '.jev', 'credentials'), '# comment\nTYPESAFE_API_KEY=file-key\n');
    expect(loadApiKey({}, home)).toBe('file-key');
    expect(() => loadApiKey({}, mkdtempSync(join(tmpdir(), 'jev-empty-')))).toThrow(/API_KEY/);
  });
});
