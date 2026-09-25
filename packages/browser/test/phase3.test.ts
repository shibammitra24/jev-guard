/**
 * Phase 3 unit tests — Combined Jev browser decision.
 *
 * Covers all five validation requirements from the plan:
 *   1. Reject missing or malformed answers.
 *   2. Reject operation/target incompatibility.
 *   3. Reject a target ID not present in the current snapshot.
 *   4. Apply existing thresholds and agent policy.
 *   5. Treat low confidence as ask or deny, never as implicit allow.
 *
 * Also verifies:
 *   - Guard signal questions are present in buildBrowserQuestions output.
 *   - buildBrowserState carries the untrusted-page-text warning.
 *   - parseBrowserDecision returns allow for clean low-risk actions.
 *   - runBrowserGoal with a deny verdict never calls session.execute().
 *   - runBrowserGoal with an ask verdict calls confirm() before execute().
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildBrowserQuestions,
  buildBrowserState,
  BROWSER_SIGNAL_QUESTIONS,
} from '../src/action-space.js';
import {
  parseBrowserChoice,
  parseBrowserDecision,
  CONFIDENCE_ASK_THRESHOLD,
  CONFIDENCE_DENY_THRESHOLD,
  type BrowserDecision,
} from '../src/decision.js';
import { runBrowserGoal, type BrowserSession } from '../src/agent.js';
import type { BrowserSnapshot, ObservedAction } from '../src/types.js';
import type { JevAnswers } from 'jev-core';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const snapshot: BrowserSnapshot = {
  url: 'http://127.0.0.1:4173',
  title: 'Demo',
  visibleText: 'Delete demo project or get more information.',
  fingerprint: 'fp-demo',
  actions: [
    { id: 'e1', node: 1, kind: 'click',  label: 'More information',  role: 'button' },
    { id: 'e2', node: 2, kind: 'submit', label: 'Delete demo project', role: 'button' },
    { id: 'e3', node: 3, kind: 'fill',   label: 'Search',             role: 'textbox' },
    { id: 'wait', kind: 'wait', label: 'Wait' },
  ],
};

const guard = { endpoint: 'http://127.0.0.1:4312', token: 'tok' };

/** Build a minimal valid JevAnswers for a given operation / target. */
function makeAnswers(
  operation: string,
  target: string | undefined,
  overrides: Partial<JevAnswers['answers']> = {},
): JevAnswers {
  const answers: JevAnswers['answers'] = {
    operation: { type: 'choice', choice: operation, confidence: 0.9, probabilities: { [operation]: 0.9 } },
    destructive:      { type: 'noul', noul: 0.05 },
    secrets:          { type: 'noul', noul: 0.02 },
    exfiltration:     { type: 'noul', noul: 0.01 },
    outsideWorkspace: { type: 'noul', noul: 0.01 },
    risk:             { type: 'score', score: 0.5, confidence: 0.9, legend: {}, probabilities: {} },
    ...overrides,
  };
  if (target) {
    answers[`${operation.toLowerCase()}_target`] = {
      type: 'choice', choice: target, confidence: 0.85, probabilities: { [target]: 0.85 },
    };
  }
  return { answers };
}

// ---------------------------------------------------------------------------
// buildBrowserQuestions — signal questions present
// ---------------------------------------------------------------------------

describe('buildBrowserQuestions — guard signal questions', () => {
  it('includes all five guard signal question keys', () => {
    const questions = buildBrowserQuestions(snapshot, 'click more information');
    for (const key of Object.keys(BROWSER_SIGNAL_QUESTIONS)) {
      expect(questions).toHaveProperty(key);
    }
  });

  it('operation question warns about untrusted page content', () => {
    const questions = buildBrowserQuestions(snapshot, 'test');
    expect((questions.operation as { instructions: string }).instructions)
      .toContain('untrusted');
  });

  it('each signal question warns about untrusted page content', () => {
    const questions = buildBrowserQuestions(snapshot, 'test');
    for (const key of Object.keys(BROWSER_SIGNAL_QUESTIONS)) {
      expect((questions[key] as { instructions: string }).instructions)
        .toContain('untrusted');
    }
  });

  it('includes SUBMIT in operation criteria when submit actions are present', () => {
    const questions = buildBrowserQuestions(snapshot, 'submit');
    const criteria = (questions.operation as { criteria: Record<string, string> }).criteria;
    expect(criteria).toHaveProperty('SUBMIT');
  });
});

// ---------------------------------------------------------------------------
// buildBrowserState — untrusted-page-text warning
// ---------------------------------------------------------------------------

describe('buildBrowserState — untrusted page text warning', () => {
  it('includes _warning field at the top level', () => {
    const state = JSON.parse(buildBrowserState(snapshot, 'goal'));
    expect(state._warning).toContain('untrusted');
  });

  it('warning appears before page.visibleText in the JSON', () => {
    const raw = buildBrowserState(snapshot, 'goal');
    const warnIdx = raw.indexOf('_warning');
    const textIdx = raw.indexOf('visibleText');
    expect(warnIdx).toBeLessThan(textIdx);
  });
});

// ---------------------------------------------------------------------------
// parseBrowserChoice — requirements 1, 2, 3
// ---------------------------------------------------------------------------

describe('parseBrowserChoice', () => {
  it('accepts a valid click action (req 1–3)', () => {
    const result = parseBrowserChoice(snapshot, makeAnswers('CLICK', 'e1'));
    expect(result).toMatchObject({ operation: 'CLICK', target: 'e1', confidence: 0.85 });
  });

  it('accepts DONE with no target', () => {
    const result = parseBrowserChoice(snapshot, makeAnswers('DONE', undefined));
    expect(result.operation).toBe('DONE');
    expect(result.target).toBeUndefined();
  });

  it('accepts WAIT with no target choice because it is code-owned', () => {
    const result = parseBrowserChoice(snapshot, makeAnswers('WAIT', undefined));
    expect(result).toMatchObject({ operation: 'WAIT', confidence: 0.9 });
    expect(result.target).toBeUndefined();
  });

  // Requirement 1
  it('req 1 — rejects missing operation answer', () => {
    expect(() => parseBrowserChoice(snapshot, { answers: {} })).toThrow(/missing operation choice/i);
  });

  it('req 1 — rejects wrong answer type for operation', () => {
    expect(() => parseBrowserChoice(snapshot, {
      answers: { operation: { type: 'noul', noul: 0.5 } },
    })).toThrow(/missing operation choice/i);
  });

  it('req 1 — rejects missing target answer for non-terminal operation', () => {
    const answers = makeAnswers('CLICK', 'e1');
    delete answers.answers.click_target;
    expect(() => parseBrowserChoice(snapshot, answers)).toThrow(/missing target choice/i);
  });

  // Requirement 2
  it('req 2 — rejects operation with no compatible observed actions', () => {
    expect(() => parseBrowserChoice(snapshot, makeAnswers('NAVIGATE', 'e1'))).toThrow(/unsupported operation/i);
  });

  // Requirement 3
  it('req 3 — rejects target ID not present in current snapshot', () => {
    const answers = makeAnswers('CLICK', 'e99'); // e99 does not exist
    expect(() => parseBrowserChoice(snapshot, answers)).toThrow(/not present in the current snapshot/i);
  });

  it('req 3 — rejects stale target ID from a previous snapshot', () => {
    const staleId = 'e999';
    const answers = makeAnswers('CLICK', staleId);
    expect(() => parseBrowserChoice(snapshot, answers))
      .toThrow(/not present in the current snapshot/i);
  });
});

// ---------------------------------------------------------------------------
// parseBrowserDecision — requirements 1–5
// ---------------------------------------------------------------------------

describe('parseBrowserDecision', () => {
  it('returns allow for a clean, low-risk action', () => {
    const result = parseBrowserDecision(snapshot, makeAnswers('CLICK', 'e1'));
    expect(result.guardDecision.verdict).toBe('allow');
    expect(result.choice.operation).toBe('CLICK');
    expect(result.choice.target).toBe('e1');
  });

  // Requirement 1 — malformed signal answers
  it('req 1 — rejects missing destructive noul answer', () => {
    const answers = makeAnswers('CLICK', 'e1');
    delete answers.answers.destructive;
    expect(() => parseBrowserDecision(snapshot, answers)).toThrow(/destructive/i);
  });

  it('req 1 — rejects wrong type for secrets answer', () => {
    const answers = makeAnswers('CLICK', 'e1');
    answers.answers.secrets = { type: 'score', score: 0.5, confidence: 0.9, legend: {}, probabilities: {} };
    expect(() => parseBrowserDecision(snapshot, answers)).toThrow(/secrets/i);
  });

  it('req 1 — rejects missing risk score answer', () => {
    const answers = makeAnswers('CLICK', 'e1');
    delete answers.answers.risk;
    expect(() => parseBrowserDecision(snapshot, answers)).toThrow(/risk/i);
  });

  // Requirement 4 — policy thresholds applied
  it('req 4 — deny when destructive signal exceeds denyNoul threshold (0.85)', () => {
    const answers = makeAnswers('SUBMIT', 'e2', {
      destructive: { type: 'noul', noul: 0.92 },
      risk:        { type: 'score', score: 0.8, confidence: 0.9, legend: {}, probabilities: {} },
    });
    const result = parseBrowserDecision(snapshot, answers);
    expect(result.guardDecision.verdict).toBe('deny');
    // policy picks the highest noul trigger; destructive=0.92 dominates at risk=0.8
    expect(result.guardDecision.reason).toMatch(/destructive/i);
  });

  it('req 4 — ask when risk score is in the ask range (1.5–2.5)', () => {
    const answers = makeAnswers('CLICK', 'e1', {
      risk: { type: 'score', score: 2.0, confidence: 0.9, legend: {}, probabilities: {} },
    });
    const result = parseBrowserDecision(snapshot, answers);
    expect(result.guardDecision.verdict).toBe('ask');
  });

  it('req 4 — deny when risk score meets denyRisk threshold (2.5)', () => {
    const answers = makeAnswers('SUBMIT', 'e2', {
      risk: { type: 'score', score: 2.8, confidence: 0.9, legend: {}, probabilities: {} },
    });
    const result = parseBrowserDecision(snapshot, answers);
    expect(result.guardDecision.verdict).toBe('deny');
  });

  // Requirement 5 — low confidence → ask or deny, never implicit allow
  it(`req 5 — confidence below DENY threshold (${CONFIDENCE_DENY_THRESHOLD}) on a low-risk step → ask, never allow`, () => {
    const answers = makeAnswers('CLICK', 'e1');
    (answers.answers.click_target as { confidence: number }).confidence = CONFIDENCE_DENY_THRESHOLD - 0.01;
    (answers.answers.operation as { confidence: number }).confidence = CONFIDENCE_DENY_THRESHOLD - 0.01;
    const result = parseBrowserDecision(snapshot, answers);
    expect(result.guardDecision.verdict).toBe('ask');
    expect(result.guardDecision.reason).toMatch(/confidence too low/i);
  });

  it(`req 5 — confidence below DENY threshold on a risky step → deny`, () => {
    const answers = makeAnswers('CLICK', 'e1', {
      risk: { type: 'score', score: 2.0, confidence: 0.9, legend: {}, probabilities: {} },
    });
    (answers.answers.click_target as { confidence: number }).confidence = CONFIDENCE_DENY_THRESHOLD - 0.01;
    const result = parseBrowserDecision(snapshot, answers);
    expect(result.guardDecision.verdict).toBe('deny');
    expect(result.guardDecision.reason).toMatch(/confidence too low/i);
  });

  it('req 5 — WAIT/SCROLL are code-owned and not confidence-gated', () => {
    const answers = makeAnswers('WAIT', undefined);
    (answers.answers.operation as { confidence: number }).confidence = 0.1;
    expect(parseBrowserDecision(snapshot, answers).guardDecision.verdict).toBe('allow');
  });

  it(`req 5 — confidence between DENY and ASK thresholds → ask (not allow)`, () => {
    const answers = makeAnswers('CLICK', 'e1');
    const mid = (CONFIDENCE_DENY_THRESHOLD + CONFIDENCE_ASK_THRESHOLD) / 2;
    (answers.answers.click_target as { confidence: number }).confidence = mid;
    (answers.answers.operation as { confidence: number }).confidence = mid;
    const result = parseBrowserDecision(snapshot, answers);
    expect(result.guardDecision.verdict).toBe('ask');
    expect(result.guardDecision.reason).toMatch(/uncertain/i);
  });

  it('req 5 — confidence above ASK threshold is not escalated', () => {
    const answers = makeAnswers('CLICK', 'e1'); // default 0.85 > 0.60
    const result = parseBrowserDecision(snapshot, answers);
    expect(result.guardDecision.verdict).toBe('allow');
  });

  it('req 5 — DONE with low confidence is not escalated (no execution risk)', () => {
    const answers = makeAnswers('DONE', undefined);
    (answers.answers.operation as { confidence: number }).confidence = 0.1;
    const result = parseBrowserDecision(snapshot, answers);
    // DONE is terminal — confidence check does not apply
    expect(result.choice.operation).toBe('DONE');
    expect(result.guardDecision.verdict).toBe('allow');
  });

  it('signals are exposed on the returned BrowserDecision', () => {
    const answers = makeAnswers('CLICK', 'e1', {
      destructive:      { type: 'noul', noul: 0.3 },
      exfiltration:     { type: 'noul', noul: 0.1 },
      outsideWorkspace: { type: 'noul', noul: 0.0 },
    });
    const result = parseBrowserDecision(snapshot, answers);
    expect(result.signals.destructive).toBeCloseTo(0.3);
    expect(result.signals.exfiltration).toBeCloseTo(0.1);
  });
});

// ---------------------------------------------------------------------------
// runBrowserGoal — Phase 3 guard-before-CDP invariant
// ---------------------------------------------------------------------------

describe('runBrowserGoal — Phase 3 guard-before-CDP invariant', () => {
  function makeSession(page: BrowserSnapshot, executeResult = { executed: true, decision: { decision: 'allow' as const, latencyMs: 1 } }): BrowserSession {
    return {
      observe: vi.fn(async () => page),
      execute: vi.fn(async () => executeResult),
    } as unknown as BrowserSession;
  }

  it('deny from guardDecision never calls session.execute()', async () => {
    const session = makeSession(snapshot);
    const result = await runBrowserGoal(session, 'delete everything', guard, {
      decide: async () => ({
        choice: { operation: 'SUBMIT', target: 'e2', confidence: 0.9, probabilities: {} },
        signals: { destructive: 0.95, secrets: 0, exfiltration: 0, outsideWorkspace: 0, risk: 3.5, userExplicit: 0, isWildcard: false },
        guardDecision: { verdict: 'deny', reason: 'Jev Guard: destructive (p=0.95)' },
      } satisfies BrowserDecision),
    });
    expect(result.status).toBe('denied');
    expect(result.reason).toMatch(/destructive/);
    expect((session.execute as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('ask from guardDecision calls confirm() and cancels if declined', async () => {
    const session = makeSession(snapshot);
    const confirm = vi.fn(async () => false);
    const result = await runBrowserGoal(session, 'submit form', guard, {
      decide: async () => ({
        choice: { operation: 'SUBMIT', target: 'e2', confidence: 0.9, probabilities: {} },
        signals: { destructive: 0.6, secrets: 0, exfiltration: 0, outsideWorkspace: 0, risk: 2.0, userExplicit: 0, isWildcard: false },
        guardDecision: { verdict: 'ask', reason: 'Jev Guard: confirm submission.' },
      } satisfies BrowserDecision),
      confirm,
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(result.status).toBe('cancelled');
    expect((session.execute as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('ask confirmed → session.execute() is called with confirmed=true', async () => {
    const session = makeSession(snapshot);
    const decide = vi.fn()
      .mockResolvedValueOnce({
        choice: { operation: 'CLICK', target: 'e1', confidence: 0.9, probabilities: {} },
        signals: { destructive: 0, secrets: 0, exfiltration: 0, outsideWorkspace: 0, risk: 2.0, userExplicit: 0, isWildcard: false },
        guardDecision: { verdict: 'ask', reason: 'Jev Guard: confirm.' },
      } satisfies BrowserDecision)
      .mockResolvedValueOnce({
        choice: { operation: 'DONE', confidence: 0.9, probabilities: {} },
        signals: { destructive: 0, secrets: 0, exfiltration: 0, outsideWorkspace: 0, risk: 0, userExplicit: 0, isWildcard: false },
        guardDecision: { verdict: 'allow' },
      } satisfies BrowserDecision);

    const result = await runBrowserGoal(session, 'click continue', guard, {
      decide,
      confirm: async () => true,
    });

    expect(result.status).toBe('done');
    expect((session.execute as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      guard,
      expect.objectContaining({ confirmed: true }),
    );
  });
});
