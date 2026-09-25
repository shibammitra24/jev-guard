import { ask, type JevAnswers } from 'jev-core';
import { buildBrowserQuestions, buildBrowserState, compatibleActions } from './action-space.js';
import { parseBrowserDecision, type BrowserDecision } from './decision.js';
import type { ExecutionResult, GuardEndpoint } from './session.js';
import { BrowserSession, BrowserSessionError } from './session.js';
import { StalePageError } from './freshness.js';
export { BrowserSession } from './session.js';
import type { BrowserSnapshot, ObservedAction } from './types.js';

export type BrowserGoalStatus = 'done' | 'blocked' | 'denied' | 'cancelled' | 'max_steps';

export interface BrowserGoalResult {
  status: BrowserGoalStatus;
  steps: number;
  history: string[];
  snapshot: BrowserSnapshot;
  reason?: string;
}

export interface BrowserGoalOptions {
  maxSteps?: number;
  /**
   * Returns a combined BrowserDecision (action choice + guard signals + policy verdict)
   * from a single Jev request. runBrowserGoal checks guardDecision before
   * calling session.execute() so a deny stops execution before CDP is touched.
   */
  decide(snapshot: BrowserSnapshot, goal: string, history: string[]): Promise<BrowserDecision>;
  confirm?: (reason: string, action: ObservedAction, decision: BrowserDecision) => Promise<boolean>;
  resolveFill?: (action: ObservedAction, goal: string) => Promise<string | undefined>;
}

/**
 * Create a decide() callback that sends one combined Jev request per browser step.
 *
 * The request includes operation choice, compatible target, and all five guard
 * signal questions (destructive, secrets, exfiltration, outsideWorkspace, risk).
 * parseBrowserDecision validates all answers and applies policy thresholds before
 * returning — the caller never receives an unvalidated answer.
 */
export function createJevBrowserDecider(apiKey: string, timeoutMs = 3000): BrowserGoalOptions['decide'] {
  return async (snapshot: BrowserSnapshot, goal: string, history: string[]): Promise<BrowserDecision> => {
    const answers: JevAnswers = await ask(
      buildBrowserState(snapshot, goal, history),
      buildBrowserQuestions(snapshot, goal),
      { apiKey, timeoutMs },
    );
    return parseBrowserDecision(snapshot, answers);
  };
}

const MAX_STALE_RETRIES = 3;

function isRetryablePageChange(error: unknown): boolean {
  if (error instanceof StalePageError) return true;
  return error instanceof BrowserSessionError && /target changed or is covered/i.test(error.message);
}

function selectedAction(snapshot: BrowserSnapshot, decision: BrowserDecision): ObservedAction | undefined {
  const { choice } = decision;
  if (choice.target) return snapshot.actions.find(action => action.id === choice.target);
  return compatibleActions(snapshot)[choice.operation]?.[0];
}

/**
 * Run a browser goal loop using a persistent BrowserSession.
 *
 * Each step:
 *   1. decide() — one Jev request covering action selection AND guard signals.
 *   2. If guardDecision is deny → return 'denied' immediately, no CDP call.
 *   3. If guardDecision is ask → require confirm() before proceeding.
 *   4. Pass to session.execute() which applies a second freshness check and
 *      calls the guard daemon as a belt-and-suspenders validation.
 */
export async function runBrowserGoal(
  session: BrowserSession,
  goal: string,
  guard: GuardEndpoint,
  options: BrowserGoalOptions,
): Promise<BrowserGoalResult> {
  const history: string[] = [];
  let snapshot = await session.observe();
  const maxSteps = Math.max(1, Math.min(options.maxSteps ?? 20, 50));
  let staleRetries = 0;

  for (let step = 0; step < maxSteps; step += 1) {
    const decision = await options.decide(snapshot, goal, history);
    const { choice, guardDecision } = decision;

    // Terminal operations
    if (choice.operation === 'DONE') return { status: 'done', steps: step, history, snapshot };
    if (choice.operation === 'BLOCKED') {
      return {
        status: 'blocked', steps: step, history, snapshot,
        reason: `No compatible observed action can make progress (observed ${snapshot.actions.length} controls on ${snapshot.url}).`,
      };
    }

    // Phase 3 requirement 4+5: check the combined guard decision BEFORE CDP
    if (guardDecision.verdict === 'deny') {
      history.push(`${choice.operation}:${choice.target ?? ''}:deny`);
      return {
        status: 'denied', steps: step + 1, history, snapshot,
        reason: guardDecision.reason ?? 'Jev Guard: action denied.',
      };
    }

    // ask: require explicit confirmation before proceeding
    if (guardDecision.verdict === 'ask' && options.confirm) {
      const confirmed = await options.confirm(
        guardDecision.reason ?? 'Jev Guard: confirm this browser action.',
        // pass the target action if we can resolve it, else a synthetic one
        selectedAction(snapshot, decision) ?? { id: choice.target ?? '', kind: 'click', label: choice.operation },
        decision,
      );
      if (!confirmed) {
        history.push(`${choice.operation}:${choice.target ?? ''}:cancelled`);
        return {
          status: 'cancelled', steps: step + 1, history, snapshot,
          reason: 'User declined the browser action.',
        };
      }
    }

    // Resolve the concrete ObservedAction
    let action = selectedAction(snapshot, decision);
    if (!action) {
      return {
        status: 'blocked', steps: step, history, snapshot,
        reason: `The selected ${choice.operation} target is unavailable.`,
      };
    }

    // Fill actions need a concrete value from the caller
    if (action.kind === 'fill') {
      const value = await options.resolveFill?.(action, goal);
      if (value === undefined) {
        return { status: 'cancelled', steps: step, history, snapshot, reason: 'Text entry was cancelled.' };
      }
      action = { ...action, value };
    }

    // session.execute() applies a second freshness check + guard daemon call
    let result: ExecutionResult;
    try {
      result = await session.execute(action, snapshot, guard, {
        // Guard already asked above; pass confirmed=true so execute doesn't ask again
        confirmed: guardDecision.verdict === 'ask',
        confirm: options.confirm
          ? (execDecision, selected) =>
              options.confirm!(execDecision.reason ?? 'Jev Guard: confirm this browser action.', selected, decision)
          : undefined,
      });
    } catch (error) {
      // Live pages (tickers, carousels, overlays) change under a decision. The
      // stale decision is discarded before any mutation; decide again on fresh state.
      if (!isRetryablePageChange(error) || staleRetries >= MAX_STALE_RETRIES) throw error;
      staleRetries += 1;
      history.push(`${choice.operation}:${action.id}:stale`);
      await new Promise(resolve => setTimeout(resolve, 150 * staleRetries));
      snapshot = await session.observe();
      continue;
    }
    staleRetries = 0;

    history.push(`${choice.operation}:${action.id}:${result.decision.decision}`);

    if (!result.executed) {
      return {
        status: result.decision.decision === 'deny' ? 'denied' : 'cancelled',
        steps: step + 1, history, snapshot,
        reason: result.decision.reason,
      };
    }

    snapshot = await session.observe();
  }

  return {
    status: 'max_steps', steps: maxSteps, history, snapshot,
    reason: `Stopped after ${maxSteps} steps.`,
  };
}
