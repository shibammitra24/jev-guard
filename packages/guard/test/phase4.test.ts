/**
 * Phase 4 tests — Guard boundary integration.
 *
 * Verifies:
 *   - isBrowserTool() correctly classifies browser_subagent vs normal tools.
 *   - browser_subagent calls are routed to the bridge, never to Jev.
 *   - Normal tool calls are not affected by the browser branch.
 *   - noBridgeDecision() fires when no sidecar is configured.
 *   - workspaceMismatchDecision() fires for cross-workspace calls.
 *   - A successful sidecar response is returned as a deny reason.
 *   - A sidecar HTTP error fails closed.
 *   - A sidecar network failure fails closed.
 *   - The bridge watchdog fires when the sidecar hangs.
 *   - Logging records browser_subagent tool name correctly.
 */
import { describe, expect, it, vi } from 'vitest';
import { isBrowserTool, BROWSER_TOOL_NAME } from '../src/adapters/agy';
import {
  runBrowserBridge,
  noBridgeDecision,
  workspaceMismatchDecision,
  type BrowserBridgeEndpoint,
} from '../src/adapters/browser-bridge';
import { runGuard } from '../src/main';
import { defaultToolPolicyState, mergeToolPolicyState, type NormalizedToolCall } from 'jev-core';
import type { GuardConfig } from '../src/config';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const WS = 'C:\\workspace\\jev-guard';

const config: GuardConfig = {
  enabled: true,
  thresholds: { denyNoul: 0.85, askNoul: 0.5, denyRisk: 2.5, askRisk: 1.5 },
  prefilterTools: ['list_dir', 'view_file'],
  timeoutMs: 50,
  logPath: 'ignored.jsonl',
  debug: false,
};
const logger = { append: vi.fn(), tail: () => [], watch: () => () => undefined };
// Explicit, catalog-default policy so these tests never depend on a real ~/.jev/tool-policy.json.
const toolPolicy = defaultToolPolicyState();

const bridge: BrowserBridgeEndpoint = {
  endpoint: 'http://127.0.0.1:4312',
  token: 'test-token',
  workspace: WS,
};

/** Minimal NormalizedToolCall for a browser_subagent call. */
function browserCall(overrides: Partial<NormalizedToolCall> = {}): NormalizedToolCall {
  return {
    agent: 'agy',
    tool: BROWSER_TOOL_NAME,
    args: {
      Task: 'Open http://127.0.0.1:4173 and click More information',
      TaskName: 'Clicking More Information',
      TaskSummary: 'Click the button.',
      RecordingName: 'click_more_info',
      toolAction: 'Clicking button',
      toolSummary: 'Button click',
    },
    workspace: WS,
    raw: {},
    ...overrides,
  };
}

/** Hook payload JSON for a browser_subagent call. */
function browserPayload(task = 'Open http://127.0.0.1:4173 and click More information'): string {
  return JSON.stringify({
    toolCall: {
      name: BROWSER_TOOL_NAME,
      args: {
        Task: task,
        TaskName: 'Demo task',
        TaskSummary: 'Test.',
        RecordingName: 'test_task',
        toolAction: 'Running task',
        toolSummary: 'Task',
      },
    },
    workspacePaths: [WS],
    conversationId: 'conv-1',
  });
}

/** Hook payload JSON for a normal shell tool call. */
function shellPayload(cmd = 'node --version'): string {
  return JSON.stringify({
    toolCall: { name: 'run_command', args: { CommandLine: cmd, Cwd: WS } },
    workspacePaths: [WS],
  });
}

/** Stub fetcher that returns a successful sidecar response. */
function okFetcher(result = 'Clicked "More information". Page shows: Details section expanded.'): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ result }), { status: 200 }),
  ) as unknown as typeof fetch;
}

/** Stub fetcher that returns an HTTP error. */
function errorFetcher(status = 500): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ error: 'internal error' }), { status }),
  ) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// isBrowserTool() classification
// ---------------------------------------------------------------------------

describe('isBrowserTool()', () => {
  it('returns true for browser_subagent', () => {
    expect(isBrowserTool(browserCall())).toBe(true);
  });

  it('returns false for run_command', () => {
    expect(isBrowserTool({ ...browserCall(), tool: 'run_command' })).toBe(false);
  });

  it('returns false for view_file', () => {
    expect(isBrowserTool({ ...browserCall(), tool: 'view_file' })).toBe(false);
  });

  it('returns false for write_to_file', () => {
    expect(isBrowserTool({ ...browserCall(), tool: 'write_to_file' })).toBe(false);
  });

  it('BROWSER_TOOL_NAME is exactly "browser_subagent"', () => {
    expect(BROWSER_TOOL_NAME).toBe('browser_subagent');
  });
});

// ---------------------------------------------------------------------------
// runBrowserBridge() — sentinel decisions
// ---------------------------------------------------------------------------

describe('runBrowserBridge() — sentinel decisions', () => {
  it('returns noBridgeDecision() when bridge is null', async () => {
    const result = await runBrowserBridge(browserCall(), null);
    expect(result.verdict).toBe('deny');
    expect(result.reason).toMatch(/no browser sidecar/i);
  });

  it('noBridgeDecision() source is fallback', () => {
    expect(noBridgeDecision().source).toBe('fallback');
  });

  it('returns workspaceMismatchDecision() when workspaces differ', async () => {
    const mismatchedCall = browserCall({ workspace: 'C:\\other-project' });
    const result = await runBrowserBridge(mismatchedCall, bridge);
    expect(result.verdict).toBe('deny');
    expect(result.reason).toMatch(/workspace mismatch/i);
    expect(result.reason).toContain('C:\\other-project');
    expect(result.reason).toContain(WS);
  });

  it('workspaceMismatchDecision() carries both workspace paths', () => {
    const d = workspaceMismatchDecision('/a', '/b');
    expect(d.reason).toContain('/a');
    expect(d.reason).toContain('/b');
    expect(d.verdict).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// runBrowserBridge() — sidecar HTTP interaction
// ---------------------------------------------------------------------------

describe('runBrowserBridge() — sidecar interaction', () => {
  it('POSTs to /v1/browser/task with task and workspace', async () => {
    const fetcher = okFetcher();
    await runBrowserBridge(browserCall(), bridge, { fetcher });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/browser/task');
    const body = JSON.parse(init.body as string) as { task: string; workspace: string };
    expect(body.task).toContain('More information');
    expect(body.workspace).toBe(WS);
  });

  it('sends the correct Bearer token', async () => {
    const fetcher = okFetcher();
    await runBrowserBridge(browserCall(), bridge, { fetcher });
    const [, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${bridge.token}`);
  });

  it('returns a deny with the sidecar result as reason', async () => {
    const result = await runBrowserBridge(browserCall(), bridge, { fetcher: okFetcher('Page expanded.') });
    expect(result.verdict).toBe('deny');
    expect(result.source).toBe('browser');
    expect(result.reason).toBe('Page expanded.');
  });

  it('fails closed on HTTP 500 from the sidecar', async () => {
    const result = await runBrowserBridge(browserCall(), bridge, { fetcher: errorFetcher(500) });
    expect(result.verdict).toBe('deny');
    expect(result.reason).toMatch(/HTTP 500/);
    expect(result.source).toBe('fallback');
  });

  it('fails closed on network error', async () => {
    const fetcher = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const result = await runBrowserBridge(browserCall(), bridge, { fetcher });
    expect(result.verdict).toBe('deny');
    expect(result.reason).toMatch(/ECONNREFUSED/);
    expect(result.source).toBe('fallback');
  });

  it('latencyMs is a non-negative number', async () => {
    const result = await runBrowserBridge(browserCall(), bridge, { fetcher: okFetcher() });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// runGuard() — browser branch routing
// ---------------------------------------------------------------------------

describe('runGuard() — browser branch routing', () => {
  it('routes browser_subagent to the bridge, never calls Jev ask()', async () => {
    const ask = vi.fn();
    const result = await runGuard(browserPayload(), ['--agent', 'agy'], {
      config, toolPolicy, logger, apiKey: 'key', ask,
      browserBridge: bridge,
      bridgeFetcher: okFetcher('Clicked successfully.'),
    });
    expect(ask).not.toHaveBeenCalled();
    // Bridge always returns deny carrying the sidecar result
    const parsed = JSON.parse(result) as { decision: string; reason: string };
    expect(parsed.decision).toBe('deny');
    expect(parsed.reason).toContain('[JEV FAST BROWSER RESULT]');
    expect(parsed.reason).not.toContain('BLOCKED BEFORE EXECUTION');
    expect(parsed.reason).toContain('Clicked successfully.');
  });

  it('normal run_command is unaffected — still evaluated by Jev', async () => {
    const safeAnswers = {
      answers: {
        destructive: { type: 'noul', noul: 0 },
        secrets:     { type: 'noul', noul: 0 },
        exfiltration: { type: 'noul', noul: 0 },
        outsideWorkspace: { type: 'noul', noul: 0 },
        risk: { type: 'score', score: 0, confidence: 1, legend: {}, probabilities: {} },
      },
    } as const;
    const ask = vi.fn().mockResolvedValue(safeAnswers);
    const result = await runGuard(shellPayload(), ['--agent', 'agy'], {
      config, toolPolicy, logger, apiKey: 'key', ask,
    });
    expect(ask).toHaveBeenCalledOnce();
    expect(JSON.parse(result)).toMatchObject({ decision: 'allow' });
  });

  it('browser automation toggled off in the Guard Console denies before reaching the bridge', async () => {
    const ask = vi.fn();
    const fetcher = okFetcher('Should never run.');
    const offPolicy = mergeToolPolicyState({ tool_browser: false });
    const result = await runGuard(browserPayload(), ['--agent', 'agy'], {
      config, toolPolicy: offPolicy, logger, apiKey: 'key', ask,
      browserBridge: bridge,
      bridgeFetcher: fetcher,
    });
    expect(ask).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    const parsed = JSON.parse(result) as { decision: string; reason: string };
    expect(parsed.decision).toBe('deny');
    expect(parsed.reason.toLowerCase()).toContain('turned off');
  });

  it('web search toggled off denies search_web and steers the agent to the browser', async () => {
    const ask = vi.fn();
    const payload = JSON.stringify({ toolCall: { name: 'search_web', args: { query: 'flights kolkata to paris' } }, workspacePaths: [WS] });
    const result = await runGuard(payload, ['--agent', 'agy'], {
      config, toolPolicy: mergeToolPolicyState({ tool_web_search: false }), logger, apiKey: 'key', ask,
    });
    expect(ask).not.toHaveBeenCalled();
    const parsed = JSON.parse(result) as { decision: string; reason: string };
    expect(parsed.decision).toBe('deny');
    expect(parsed.reason).toContain('"Web search" is turned off');
    expect(parsed.reason).toContain('browser_subagent');
  });

  it('browser automation off also denies the sidecar per-action calls', async () => {
    const ask = vi.fn();
    const payload = JSON.stringify({ toolCall: { name: 'browser_click', args: { action: { id: 'e1' } } }, workspacePaths: [WS] });
    const result = await runGuard(payload, ['--agent', 'agy'], {
      config, toolPolicy: mergeToolPolicyState({ tool_browser: false }), logger, apiKey: 'key', ask,
    });
    expect(ask).not.toHaveBeenCalled();
    expect(JSON.parse(result)).toMatchObject({ decision: 'deny' });
  });

  it('browser_subagent with no bridge configured is denied with explanation', async () => {
    const ask = vi.fn();
    const result = await runGuard(browserPayload(), ['--agent', 'agy'], {
      config, toolPolicy, logger, apiKey: 'key', ask,
      browserBridge: null,
    });
    expect(ask).not.toHaveBeenCalled();
    const parsed = JSON.parse(result) as { decision: string; reason: string };
    expect(parsed.decision).toBe('deny');
    expect(parsed.reason).toMatch(/no browser sidecar/i);
  });

  it('browser bridge watchdog fires and fails closed when sidecar hangs', async () => {
    const ask = vi.fn();
    const hangingFetcher = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const result = await runGuard(browserPayload(), ['--agent', 'agy'], {
      config, toolPolicy, logger, apiKey: 'key', ask,
      browserBridge: bridge,
      bridgeFetcher: hangingFetcher,
      watchdogMs: 10,
    });
    const parsed = JSON.parse(result) as { decision: string; reason: string };
    // Watchdog returns fallback → rendered as deny (fallback source → deny in agyAdapter.render)
    expect(parsed.decision).toBe('deny');
    expect(parsed.reason).toMatch(/timed out/i);
  });

  it('logs the browser_subagent tool name and decision', async () => {
    const logged: unknown[] = [];
    const testLogger = { append: (r: unknown) => logged.push(r), tail: () => [], watch: () => () => undefined };
    await runGuard(browserPayload(), ['--agent', 'agy'], {
      config, toolPolicy, logger: testLogger, apiKey: 'key',
      browserBridge: bridge,
      bridgeFetcher: okFetcher('Done.'),
    });
    expect(logged).toHaveLength(1);
    const entry = logged[0] as Record<string, unknown>;
    expect(entry['tool']).toBe(BROWSER_TOOL_NAME);
    expect(entry['verdict']).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// Fixture-based: Phase 0 browser fixtures parse and route correctly
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES_DIR = join(__dirname, 'fixtures');

describe('Phase 0 fixtures — browser routing in runGuard', () => {
  const ACTIONS = ['navigate', 'click', 'type', 'select', 'scroll', 'wait', 'submit'] as const;

  for (const action of ACTIONS) {
    it(`agy-browser-${action}.json is classified as a browser tool and denied without Jev`, async () => {
      const payload = readFileSync(join(FIXTURES_DIR, `agy-browser-${action}.json`), 'utf8');
      const ask = vi.fn();
      const result = await runGuard(payload, ['--agent', 'agy'], {
        config, toolPolicy, logger, apiKey: 'key', ask,
        browserBridge: null, // no sidecar — expect noBridgeDecision
      });
      expect(ask).not.toHaveBeenCalled();
      const parsed = JSON.parse(result) as { decision: string };
      expect(parsed.decision).toBe('deny');
    });
  }
});
