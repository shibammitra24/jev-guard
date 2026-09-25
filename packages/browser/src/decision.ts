import type { GuardSignals, JevAnswers, JevAnswer } from 'jev-core';
import { decide, DEFAULT_THRESHOLDS, type PolicyDecision, type Thresholds } from 'jev-core';
import type { BrowserChoice, BrowserSnapshot } from './types.js';
import { compatibleActions, BROWSER_SIGNAL_KEYS, CONTROL_OPERATIONS } from './action-space.js';

// ---------------------------------------------------------------------------
// Confidence thresholds
// Phase 3 rule: treat low confidence as ask or deny, never as implicit allow.
// ---------------------------------------------------------------------------

/** Below this, the action choice is treated as uncertain → ask. */
export const CONFIDENCE_ASK_THRESHOLD = 0.60;
/** Below this, the action choice is unreliable → deny. */
export const CONFIDENCE_DENY_THRESHOLD = 0.35;

// ---------------------------------------------------------------------------
// Combined browser decision type
// ---------------------------------------------------------------------------

/**
 * The result of a single combined Jev request for one browser step.
 *
 * `choice`       — which action the model selected (operation + target ID)
 * `signals`      — the five guard signal values extracted from the same request
 * `guardDecision`— the policy verdict derived from signals + confidence
 */
export interface BrowserDecision {
  choice: BrowserChoice;
  signals: GuardSignals;
  guardDecision: PolicyDecision;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function requireNoul(answers: JevAnswers['answers'], key: string): number {
  const answer: JevAnswer | undefined = answers[key];
  if (!answer || answer.type !== 'noul' || !Number.isFinite(answer.noul)) {
    throw new Error(`Browser Jev response: missing or invalid noul answer "${key}"`);
  }
  return answer.noul;
}

function requireScore(answers: JevAnswers['answers'], key: string): number {
  const answer: JevAnswer | undefined = answers[key];
  if (!answer || answer.type !== 'score' || !Number.isFinite(answer.score)) {
    throw new Error(`Browser Jev response: missing or invalid score answer "${key}"`);
  }
  return answer.score;
}

// ---------------------------------------------------------------------------
// parseBrowserChoice — unchanged contract, kept for the existing goal loop
// ---------------------------------------------------------------------------

/**
 * Validate and extract the action choice from Jev answers.
 * Does NOT apply guard signals — use parseBrowserDecision for the full pipeline.
 *
 * Validation (Phase 3 requirements 1–3):
 *   1. Rejects missing or malformed operation/target answers.
 *   2. Rejects operation/target incompatibility.
 *   3. Rejects a target ID not present in the current snapshot.
 */
export function parseBrowserChoice(snapshot: BrowserSnapshot, result: JevAnswers): BrowserChoice {
  const operationAnswer = result.answers.operation;
  // Requirement 1 — reject missing/malformed
  if (!operationAnswer || operationAnswer.type !== 'choice') {
    throw new Error('Browser Jev response: missing operation choice');
  }
  const operation = operationAnswer.choice;

  // Terminal operations need no target
  if (operation === 'DONE' || operation === 'BLOCKED') {
    return { operation, confidence: operationAnswer.confidence, probabilities: operationAnswer.probabilities };
  }

  // Requirement 2 — operation must match an available group
  const groups = compatibleActions(snapshot);
  const candidates = groups[operation];
  if (!candidates?.length) {
    throw new Error(`Browser Jev response: unsupported operation "${operation}" — no compatible observed actions`);
  }

  // WAIT and SCROLL are code-owned control operations. Their concrete action
  // is selected deterministically from the compatible group, so the question
  // builder intentionally does not emit wait_target/scroll_target. Requiring a
  // target answer here made every valid WAIT response fail at runtime.
  if (CONTROL_OPERATIONS.includes(operation.toLowerCase() as typeof CONTROL_OPERATIONS[number])) {
    return { operation, confidence: operationAnswer.confidence, probabilities: operationAnswer.probabilities };
  }

  // Requirement 1 — target answer present and correct type
  const targetKey = `${operation.toLowerCase()}_target`;
  const targetAnswer = result.answers[targetKey];
  if (!targetAnswer || targetAnswer.type !== 'choice') {
    throw new Error(`Browser Jev response: missing target choice for operation "${operation}"`);
  }

  // Requirement 3 — target ID must exist in the current snapshot
  if (!candidates.some(action => action.id === targetAnswer.choice)) {
    throw new Error(
      `Browser Jev response: target ID "${targetAnswer.choice}" is not present in the current snapshot` +
      ` (stale or hallucinated action ID rejected)`,
    );
  }

  return {
    operation,
    target: targetAnswer.choice,
    confidence: Math.min(operationAnswer.confidence, targetAnswer.confidence),
    probabilities: targetAnswer.probabilities,
  };
}

// ---------------------------------------------------------------------------
// parseBrowserDecision — combined action + guard signals
// ---------------------------------------------------------------------------

/**
 * Validate and extract the full combined browser decision from Jev answers.
 *
 * Implements all five Phase 3 validation requirements:
 *   1. Rejects missing or malformed answers (both choice and signal fields).
 *   2. Rejects operation/target incompatibility (via parseBrowserChoice).
 *   3. Rejects a target ID not present in the current snapshot (via parseBrowserChoice).
 *   4. Applies existing policy thresholds to guard signals (via decide()).
 *   5. Treats low action-choice confidence as ask or deny — never as implicit allow.
 *
 * The `_warning` field in buildBrowserState instructs the model to treat page
 * content as untrusted data; this function enforces that no page-text-derived
 * value can bypass validation.
 */
export function parseBrowserDecision(
  snapshot: BrowserSnapshot,
  result: JevAnswers,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): BrowserDecision {
  // Requirements 1–3: action choice validation
  const choice = parseBrowserChoice(snapshot, result);

  // Requirement 1: signal answers must be present and well-typed
  const signals: GuardSignals = {
    destructive:      requireNoul(result.answers, 'destructive'),
    secrets:          requireNoul(result.answers, 'secrets'),
    exfiltration:     requireNoul(result.answers, 'exfiltration'),
    outsideWorkspace: requireNoul(result.answers, 'outsideWorkspace'),
    risk:             requireScore(result.answers, 'risk'),
    // userExplicit: browser actions are never single-file targeted deletes; default to 0 (no downgrade)
    userExplicit:     0,
    // isWildcard: browser path never involves wildcard shell commands
    isWildcard:       false,
  };

  // Validate every expected signal key is present (catches future schema drift)
  for (const key of BROWSER_SIGNAL_KEYS) {
    if (!(key in signals)) {
      throw new Error(`Browser Jev response: missing signal "${key}"`);
    }
  }

  // Requirement 4: apply policy thresholds to guard signals
  let guardDecision: PolicyDecision = decide(signals, 'agy', thresholds);

  // Requirement 5: low action-choice confidence → escalate to ask or deny
  // Only applies to non-terminal choices (DONE/BLOCKED have no execution risk)
  if (choice.operation !== 'DONE' && choice.operation !== 'BLOCKED') {
    if (choice.confidence < CONFIDENCE_DENY_THRESHOLD) {
      guardDecision = {
        verdict: 'deny',
        reason: `Jev Guard: action-choice confidence too low (${choice.confidence.toFixed(2)} < ${CONFIDENCE_DENY_THRESHOLD}) — blocked to prevent unintended execution.`,
      };
    } else if (choice.confidence < CONFIDENCE_ASK_THRESHOLD && guardDecision.verdict === 'allow') {
      // Confidence is uncertain — escalate allow → ask
      guardDecision = {
        verdict: 'ask',
        reason: `Jev Guard: action-choice confidence uncertain (${choice.confidence.toFixed(2)} < ${CONFIDENCE_ASK_THRESHOLD}) — confirm before executing.`,
      };
    }
  }

  return { choice, signals, guardDecision };
}
