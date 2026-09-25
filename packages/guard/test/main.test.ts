import { describe, expect, it, vi } from 'vitest';
import { defaultToolPolicyState, mergeToolPolicyState } from 'jev-core';
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
// Explicit, catalog-default policy so these tests never depend on a real ~/.jev/tool-policy.json.
const toolPolicy = defaultToolPolicyState();
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
    expect(await runGuard('{bad', ['--agent', 'agy'], { config, toolPolicy, logger })).toContain('"decision":"deny"');
    expect(await runGuard(payload, ['--agent', 'agy'], { config, toolPolicy, logger })).toContain('"decision":"deny"');
  });

  it('prefilters safe calls without Jev', async () => {
    const ask = vi.fn();
    const output = await runGuard(JSON.stringify({ toolCall: { name: 'view_file', args: { AbsolutePath: 'src/a.ts' } } }), ['--agent', 'agy'], {
      config, toolPolicy, logger, apiKey: 'test', ask,
    });
    expect(output).toBe('{"decision":"allow"}');
    expect(ask).not.toHaveBeenCalled();
  });

  it('allows bounded non-secret source edits inside the selected workspace without Jev', async () => {
    const ask = vi.fn();
    const output = await runGuard(JSON.stringify({
      toolCall: { name: 'replace_file_content', args: { TargetFile: 'src/main.jsx', CodeContent: 'export default function App() {}' } },
      workspacePaths: ['C:/workspace'],
    }), ['--agent', 'agy'], { config, toolPolicy, logger, apiKey: 'test', ask });
    expect(output).toBe('{"decision":"allow"}');
    expect(ask).not.toHaveBeenCalled();
  });

  it('blocks an edit that escapes the selected workspace without Jev', async () => {
    const ask = vi.fn();
    const output = await runGuard(JSON.stringify({
      toolCall: { name: 'write_to_file', args: { TargetFile: '../outside.txt', CodeContent: 'no' } },
      workspacePaths: ['C:/workspace'],
    }), ['--agent', 'agy'], { config, toolPolicy, logger, apiKey: 'test', ask });
    expect(output).toContain('"decision":"deny"');
    expect(ask).not.toHaveBeenCalled();
  });

  it('calls Jev and renders its decision', async () => {
    const output = await runGuard(JSON.stringify({
      toolCall: { name: 'run_command', args: { CommandLine: 'echo hello' } },
      workspacePaths: ['C:/workspace'],
    }), ['--agent', 'agy'], {
      config, toolPolicy, logger, apiKey: 'test', ask: vi.fn().mockResolvedValue(safeAnswers),
    });
    expect(output).toBe('{"decision":"allow"}');
  });

  it('uses a safe fallback when Jev hangs', async () => {
    const ask = vi.fn().mockReturnValue(new Promise(() => undefined));
    const output = await runGuard(payload, ['--agent', 'agy'], { config, toolPolicy, logger, apiKey: 'test', ask, watchdogMs: 5 });
    expect(output).toContain('"decision":"deny"');
  });
});

describe('Guard Console allow/deny list', () => {
  it('destructive commands are still blocked by default, without calling Jev', async () => {
    const ask = vi.fn();
    const output = await runGuard(payload, ['--agent', 'agy'], { config, toolPolicy, logger, apiKey: 'test', ask });
    expect(output).toContain('"decision":"deny"');
    expect(ask).not.toHaveBeenCalled();
  });

  it('toggling a tool off denies every call to it, before Jev is asked', async () => {
    const ask = vi.fn();
    const offPolicy = mergeToolPolicyState({ tool_run_command: false });
    const output = await runGuard(JSON.stringify({
      toolCall: { name: 'run_command', args: { CommandLine: 'echo hello' } },
      workspacePaths: ['C:/workspace'],
    }), ['--agent', 'agy'], { config, toolPolicy: offPolicy, logger, apiKey: 'test', ask });
    expect(output).toContain('"decision":"deny"');
    expect(output.toLowerCase()).toContain('turned off');
    expect(ask).not.toHaveBeenCalled();
  });

  it('toggling a dangerous category on allows it outright, without asking Jev', async () => {
    const ask = vi.fn();
    const onPolicy = mergeToolPolicyState({ op_destructive: true });
    const output = await runGuard(payload, ['--agent', 'agy'], {
      config, toolPolicy: onPolicy, logger, apiKey: 'test', ask,
    });
    expect(output).toBe('{"decision":"allow"}');
    expect(ask).not.toHaveBeenCalled();
  });

  it('only the toggled category is allowed; other dangerous categories stay blocked', async () => {
    const ask = vi.fn();
    const onPolicy = mergeToolPolicyState({ op_destructive: true });
    const output = await runGuard(JSON.stringify({
      toolCall: { name: 'view_file', args: { AbsolutePath: 'C:/workspace/.env' } },
      workspacePaths: ['C:/workspace'],
    }), ['--agent', 'agy'], { config, toolPolicy: onPolicy, logger, apiKey: 'test', ask });
    expect(output).not.toBe('{"decision":"allow"}');
    expect(ask).not.toHaveBeenCalled();
  });

  it('a disabled tool is denied even when its operation category is toggled on', async () => {
    const ask = vi.fn();
    const mixedPolicy = mergeToolPolicyState({ op_destructive: true, tool_run_command: false });
    const output = await runGuard(payload, ['--agent', 'agy'], { config, toolPolicy: mixedPolicy, logger, apiKey: 'test', ask });
    expect(output).toContain('"decision":"deny"');
    expect(ask).not.toHaveBeenCalled();
  });
});
