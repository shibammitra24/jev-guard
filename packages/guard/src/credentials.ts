import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { JevError } from 'jev-core';

export function loadApiKey(env: NodeJS.ProcessEnv = process.env, homeDir = homedir()): string {
  const fromEnv = env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const contents = readFileSync(join(homeDir, '.jev', 'credentials'), 'utf8');
    const line = contents.split(/\r?\n/).find((item) => item.trim().startsWith('TYPESAFE_API_KEY='));
    const value = line?.slice(line.indexOf('=') + 1).trim();
    if (value) return value;
  } catch {
    // Missing or unreadable credentials are reported uniformly below.
  }
  throw new JevError('auth', 'TYPESAFE_API_KEY is not configured');
}
