import { describe, expect, it, vi } from 'vitest';
import type { GuardConfig } from '../src/config';
import { runGuard } from '../src/main';

const config: GuardConfig = {
  enabled: true,
  thresholds: { denyNoul: 0.85, askNoul: 0.5, denyRisk: 2.5, askRisk: 1.5 },
  prefilterTools: ['list_dir', 'view_file', 'Read', 'Glob', 'Grep'],
  timeoutMs: 50,
  logPath: 'ignored.jsonl',
  debug: false,
};
const logger = { append: vi.fn(), tail: () => [], watch: () => () => undefined };
const payload = JSON.stringify({
  toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf ./src' } },
  workspacePaths: ['C:/workspace'],
});
const safeAnswers = {
  answers: {
    destructive: { type: 'noul', noul: 0 },
    secrets: { type: 'noul', noul: 0 },
    exfiltration: { type: 'noul', noul: 0 },
    outsideWorkspace: { type: 'noul', noul: 0 },
    risk: { type: 'score', score: 0, confidence: 1, legend: {}, probabilities: { '0': 1 } },
  },
} as const;

describe('guard pipeline', () => {
  it('fails closed on malformed input and missing key', async () => {
    expect(await runGuard('{bad', ['--agent', 'agy'], { config, logger })).toContain('"decision":"deny"');
    expect(await runGuard(payload, ['--agent', 'agy'], { config, logger })).toContain('"decision":"deny"');
  });

  it('prefilters safe calls without Jev', async () => {
    const ask = vi.fn();
    const output = await runGuard(JSON.stringify({ toolCall: { name: 'view_file', args: { AbsolutePath: 'src/a.ts' } } }), ['--agent', 'agy'], {
      config, logger, apiKey: 'test', ask,
    });
    expect(output).toBe('{"decision":"allow"}');
    expect(ask).not.toHaveBeenCalled();
  });

  it('calls Jev and renders its decision', async () => {
    const output = await runGuard(payload, ['--agent', 'agy'], {
      config, logger, apiKey: 'test', ask: vi.fn().mockResolvedValue(safeAnswers),
    });
    expect(output).toBe('{"decision":"allow"}');
  });

  it('uses a safe fallback when Jev hangs', async () => {
    const ask = vi.fn().mockReturnValue(new Promise(() => undefined));
    const output = await runGuard(payload, ['--agent', 'agy'], { config, logger, apiKey: 'test', ask, watchdogMs: 5 });
    expect(output).toContain('"decision":"deny"');
  });
});
