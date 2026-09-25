import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agyAdapter } from '../src/adapters/agy';

const FIXTURES_DIR = join(__dirname, 'fixtures');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8'));
}

describe('Antigravity adapter', () => {
  it('parses the captured payload shape', () => {
    const call = agyAdapter.parse({
      toolCall: { name: 'run_command', args: { CommandLine: 'node --version' } },
      workspacePaths: ['C:/workspace'],
      conversationId: 'conversation',
    });
    expect(call).toMatchObject({ agent: 'agy', tool: 'run_command', workspace: 'C:/workspace' });
  });

  it('renders byte-stable decisions', () => {
    expect(agyAdapter.render({ verdict: 'allow', source: 'prefilter', latencyMs: 1 }))
      .toBe('{"decision":"allow"}');
    expect(agyAdapter.render({ verdict: 'ask', source: 'jev', latencyMs: 1, reason: 'confirm' }))
      .toBe('{"decision":"ask","reason":"confirm"}');
    expect(agyAdapter.render({ verdict: 'ask', source: 'fallback', latencyMs: 1, reason: 'offline' }))
      .toBe('{"decision":"deny","reason":"offline"}');
    expect(agyAdapter.render({ verdict: 'deny', source: 'jev', latencyMs: 1, reason: 'blocked' }))
      .toBe('{"decision":"deny","reason":"blocked"}');
  });
});

describe('Phase 0 browser fixtures', () => {
  const BROWSER_ACTIONS = ['navigate', 'click', 'type', 'select', 'scroll', 'wait', 'submit'] as const;

  for (const action of BROWSER_ACTIONS) {
    it(`agy-browser-${action}.json parses as a valid browser_subagent call`, () => {
      const payload = loadFixture(`agy-browser-${action}.json`);
      const call = agyAdapter.parse(payload);
      expect(call.agent).toBe('agy');
      expect(call.tool).toBe('browser_subagent');
      expect(typeof call.args['Task']).toBe('string');
      expect((call.args['Task'] as string).length).toBeGreaterThan(0);
      expect(typeof call.args['TaskName']).toBe('string');
      expect(typeof call.args['RecordingName']).toBe('string');
      expect(call.workspace).toBe('C:/workspace/jev-guard');
    });
  }

  it('all seven action fixture tool names are browser_subagent', () => {
    const names = BROWSER_ACTIONS.map((action) => {
      const payload = loadFixture(`agy-browser-${action}.json`);
      const call = agyAdapter.parse(payload);
      return call.tool;
    });
    expect(names.every((n) => n === 'browser_subagent')).toBe(true);
  });
});
