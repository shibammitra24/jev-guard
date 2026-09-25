import { describe, expect, it } from 'vitest';
import { collectContext } from '../src/router/context.js';
import { createRegistry } from '../src/router/registry.js';
import { createExecutors } from '../src/router/executors.js';
import { routeCommand } from '../src/router/router.js';

describe('router', () => {
  it('runs high-confidence commands and resolves URLs', async () => { const opened: string[] = []; const registry = createRegistry(createExecutors({ openExternal: async url => { opened.push(url); } })); const result = await routeCommand('open https://example.com', collectContext(), { tool: 'open_url', confidence: .94 }, registry); expect(result.status).toBe('run'); if (result.status === 'run') await registry.byName(result.tool)!.execute(result.args); expect(opened).toEqual(['https://example.com']); });
  it('returns top three choices for the middle confidence band', async () => { const result = await routeCommand('do something', collectContext(), { tool: 'run_tests', confidence: .65, probabilities: { run_tests: .65, git_diff: .2, open_file: .1, open_url: .05 } }, createRegistry([])); expect(result).toEqual({ status: 'choose', options: ['run_tests', 'git_diff', 'open_file'] }); });
  it('explains low confidence', async () => { const result = await routeCommand('???', collectContext(), { tool: 'run_tests', confidence: .2 }, createRegistry([])); expect(result.status).toBe('message'); });
});
