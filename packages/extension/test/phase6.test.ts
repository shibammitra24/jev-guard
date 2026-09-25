import { describe, expect, it } from 'vitest';
import { renderConsoleHtml, summarize, type DecisionRecord, type BrowserViewStatus } from '../src/console.js';

describe('Phase 6 — Console and Observability', () => {
  it('summarize() computes all required performance counters', () => {
    const records: DecisionRecord[] = [
      { ts: '2026-09-25T10:00:00Z', route: 'command', stage: 'prompt_received', decision: 'allow', latencyMs: 0 },
      { ts: '2026-09-25T10:00:01Z', route: 'command', stage: 'route_selected', decision: 'allow', latencyMs: 0 },
      { ts: '2026-09-25T10:00:02Z', route: 'command', stage: 'jev_decision', decision: 'deny', latencyMs: 80, source: 'jev' },
      { ts: '2026-09-25T10:00:03Z', route: 'command', stage: 'workflow_result', decision: 'deny', latencyMs: 80 },
      { ts: '2026-09-25T10:01:00Z', route: 'browser', stage: 'prompt_received', decision: 'allow', latencyMs: 0 },
      { ts: '2026-09-25T10:01:01Z', route: 'browser', stage: 'browser_session', decision: 'allow', url: 'https://example.com', controls: 12, latencyMs: 15 },
      { ts: '2026-09-25T10:01:02Z', route: 'browser', stage: 'jev_decision', actionId: 'e1', actionLabel: 'Click me', decision: 'ask', latencyMs: 120, source: 'jev' },
      { ts: '2026-09-25T10:01:03Z', route: 'browser', stage: 'workflow_result', tool: 'browser_goal', decision: 'allow', status: 'done', latencyMs: 150 },
    ];

    const browserStatus: BrowserViewStatus = {
      running: true,
      protocolCalls: 42,
      screenshots: 0,
      jevRequests: 2,
      completedGoals: 1,
      blockedGoals: 0,
      failedGoals: 0,
      pageUrl: 'https://example.com',
      observedActions: 12,
    };

    const summary = summarize(records, browserStatus);

    expect(summary.total).toBe(8);
    expect(summary.allowed).toBe(5);
    expect(summary.denied).toBe(2);
    expect(summary.asked).toBe(1);
    expect(summary.browser).toBe(4);
    expect(summary.jevRequests).toBe(2);
    expect(summary.cdpCalls).toBe(42);
    expect(summary.screenshots).toBe(0);
    expect(summary.completedGoals).toBe(1);
    expect(summary.blockedGoals).toBe(0);
    expect(summary.failedGoals).toBe(0);
    expect(summary.p50).toBeGreaterThan(0);
    expect(summary.p95).toBeGreaterThan(summary.p50);
  });

  it('renderConsoleHtml() renders single chronological stream with all required elements', () => {
    const records: DecisionRecord[] = [
      {
        ts: '2026-09-25T10:00:00Z',
        route: 'browser',
        stage: 'prompt_received',
        reason: 'Open https://example.com and click button',
        decision: 'allow',
      },
      {
        ts: '2026-09-25T10:00:01Z',
        route: 'browser',
        stage: 'route_selected',
        reason: 'Prompt routed to browser: Open https://example.com',
        decision: 'allow',
      },
      {
        ts: '2026-09-25T10:00:02Z',
        route: 'browser',
        stage: 'browser_session',
        url: 'https://example.com',
        controls: 15,
        decision: 'allow',
      },
      {
        ts: '2026-09-25T10:00:03Z',
        route: 'browser',
        stage: 'jev_decision',
        actionId: 'btn-1',
        actionLabel: 'Submit Form',
        operation: 'CLICK',
        target: 'btn-1',
        decision: 'allow',
        latencyMs: 85,
        source: 'jev',
      },
      {
        ts: '2026-09-25T10:00:04Z',
        route: 'browser',
        stage: 'page_stale',
        reason: 'Page fingerprint changed before action execution',
        decision: 'deny',
      },
      {
        ts: '2026-09-25T10:00:05Z',
        route: 'browser',
        stage: 'host_error',
        reason: 'CDP connection dropped unexpectedly',
        decision: 'deny',
      },
      {
        ts: '2026-09-25T10:00:06Z',
        route: 'browser',
        stage: 'workflow_result',
        decision: 'allow',
        reason: 'Goal finished: done',
        latencyMs: 250,
      },
    ];

    const html = renderConsoleHtml(records, {
      running: true,
      protocolCalls: 10,
      screenshots: 0,
      jevRequests: 1,
      pageUrl: 'https://example.com',
      observedActions: 15,
      completedGoals: 1,
      blockedGoals: 0,
      failedGoals: 0,
    });

    // Workflow stream headers and cards
    expect(html).toContain('Workflow Stream');
    expect(html).toContain('Total Events');
    expect(html).toContain('Jev Requests');
    expect(html).toContain('CDP Calls');
    expect(html).toContain('Screenshots');
    expect(html).toContain('Goals Done');
    expect(html).toContain('Goals Blocked');
    expect(html).toContain('Goals Failed');
    expect(html).toContain('p50 Latency');
    expect(html).toContain('p95 Latency');

    // Chronological event representations
    expect(html).toContain('Prompt Received');
    expect(html).toContain('Route Selected');
    expect(html).toContain('Browser Session');
    expect(html).toContain('Jev Decision');
    expect(html).toContain('Page Stale');
    expect(html).toContain('Host Error');
    expect(html).toContain('Workflow Result');

    // Action and target details
    expect(html).toContain('[btn-1]');
    expect(html).toContain('Submit Form');
    expect(html).toContain('op: CLICK → btn-1');
    expect(html).toContain('15 controls');
    expect(html).toContain('85ms');
  });

  it('renders empty placeholder row when no events are logged', () => {
    const html = renderConsoleHtml([], { running: false, protocolCalls: 0, screenshots: 0 });
    expect(html).toContain('No workflow events yet');
  });
});
