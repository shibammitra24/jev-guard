import { describe, expect, it } from 'vitest';
import { buildGuardState } from '../src/questions';

describe('buildGuardState', () => {
  it('sorts argument keys and renders stable metadata', () => {
    const state = buildGuardState({
      agent: 'agy',
      tool: 'run_command',
      args: { z: 1, a: 'x' },
      workspace: 'C:/workspace',
      raw: {},
    });
    expect(state).toBe(
      'Agent: antigravity\nTool: run_command\nArguments:\n  a: "x"\n  z: 1\nWorkspace: C:/workspace',
    );
  });

  it('middle-truncates oversized state', () => {
    const state = buildGuardState({
      agent: 'agy',
      tool: 'write_to_file',
      args: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`content${index}`, 'x'.repeat(50_000)])),
      raw: {},
    });
    expect(state).toHaveLength(4000);
    expect(state).toContain('…[truncated]…');
  });
});
