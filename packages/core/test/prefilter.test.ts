import { describe, expect, it } from 'vitest';
import { prefilter } from '../src/prefilter';

const call = (tool: string, args: Record<string, unknown> = {}) => ({
  agent: 'agy' as const,
  tool,
  args,
  raw: {},
});

describe('prefilter', () => {
  it('allows ordinary read-only tools', () => {
    expect(prefilter(call('list_dir', { DirectoryPath: 'src' }))).toBe('allow');
    expect(prefilter(call('view_file', { AbsolutePath: 'src/index.ts' }))).toBe('allow');
    expect(prefilter(call('read_url_content', { Url: 'https://example.com/docs' }))).toBe('allow');
  });

  it('checks suspicious paths and values', () => {
    expect(prefilter(call('view_file', { AbsolutePath: '.env' }))).toBe('check');
    expect(prefilter(call('list_dir', { DirectoryPath: 'secrets' }))).toBe('check');
  });

  it('never shortcuts shell tools', () => {
    expect(prefilter(call('run_command', { CommandLine: 'ls' }))).toBe('check');
    expect(prefilter(call('Bash', { command: 'pwd' }))).toBe('check');
  });
});
