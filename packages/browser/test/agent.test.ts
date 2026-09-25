import { describe, expect, it, vi } from 'vitest';
import { runBrowserGoal, StalePageError, type BrowserSession, type BrowserSnapshot } from '../src/index.js';
import type { BrowserDecision } from '../src/decision.js';

const page: BrowserSnapshot = {
  url: 'https://example.com',
  title: 'Example',
  visibleText: 'Continue',
  fingerprint: 'v1',
  actions: [{ id: 'e1', node: 1, kind: 'click', label: 'Continue' }],
};

const guard = { endpoint: 'http://127.0.0.1:1', token: 'token' };

/** Minimal valid BrowserDecision that allows the chosen action. */
function allowDecision(operation: string, target?: string): BrowserDecision {
  return {
    choice: { operation, target, confidence: 0.9, probabilities: {} },
    signals: { destructive: 0, secrets: 0, exfiltration: 0, outsideWorkspace: 0, risk: 0, userExplicit: 0, isWildcard: false },
    guardDecision: { verdict: 'allow' },
  };
}

/** Minimal valid BrowserDecision that denies the chosen action. */
function denyDecision(operation: string, target?: string): BrowserDecision {
  return {
    choice: { operation, target, confidence: 0.9, probabilities: {} },
    signals: { destructive: 0.95, secrets: 0, exfiltration: 0, outsideWorkspace: 0, risk: 3.5, userExplicit: 0, isWildcard: false },
    guardDecision: { verdict: 'deny', reason: 'unsafe' },
  };
}

describe('browser goal runner', () => {
  it('runs an observed action and stops when the goal is done', async () => {
    const execute = vi.fn(async () => ({
      executed: true,
      decision: { decision: 'allow' as const, latencyMs: 1 },
    }));
    const session = { observe: vi.fn(async () => page), execute } as unknown as BrowserSession;
    const decide = vi.fn()
      .mockResolvedValueOnce(allowDecision('CLICK', 'e1'))
      .mockResolvedValueOnce(allowDecision('DONE'));

    const result = await runBrowserGoal(session, 'continue', guard, { decide });

    expect(result.status).toBe('done');
    expect(result.steps).toBe(1);
    expect(execute).toHaveBeenCalledWith(page.actions[0], page, guard, expect.any(Object));
  });

  it('stops immediately after a denied action — no CDP mutation', async () => {
    const execute = vi.fn();
    const session = {
      observe: vi.fn(async () => page),
      execute,
    } as unknown as BrowserSession;

    const result = await runBrowserGoal(session, 'delete account', guard, {
      decide: async () => denyDecision('CLICK', 'e1'),
    });

    expect(result).toMatchObject({ status: 'denied', steps: 1, reason: 'unsafe' });
    // guardDecision deny fires before session.execute → no CDP calls
    expect(execute).not.toHaveBeenCalled();
  });

  it('re-observes and decides again when a live page changes under the decision', async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(new StalePageError())
      .mockResolvedValueOnce({ executed: true, decision: { decision: 'allow' as const, latencyMs: 1 } });
    const observe = vi.fn(async () => page);
    const session = { observe, execute } as unknown as BrowserSession;
    const decide = vi.fn()
      .mockResolvedValueOnce(allowDecision('CLICK', 'e1'))
      .mockResolvedValueOnce(allowDecision('CLICK', 'e1'))
      .mockResolvedValueOnce(allowDecision('DONE'));

    const result = await runBrowserGoal(session, 'continue', guard, { decide });

    expect(result.status).toBe('done');
    expect(result.history).toEqual(['CLICK:e1:stale', 'CLICK:e1:allow']);
    expect(decide).toHaveBeenCalledTimes(3);
  });

  it('gives up after repeated page changes and fails closed', async () => {
    const execute = vi.fn().mockRejectedValue(new StalePageError());
    const session = { observe: vi.fn(async () => page), execute } as unknown as BrowserSession;

    await expect(runBrowserGoal(session, 'continue', guard, {
      decide: async () => allowDecision('CLICK', 'e1'),
    })).rejects.toBeInstanceOf(StalePageError);
    expect(execute).toHaveBeenCalledTimes(4);
  });
});
