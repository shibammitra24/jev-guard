import type { AgentKind, GuardSignals, Verdict } from './types';

export interface Thresholds {
  denyNoul: number;
  askNoul: number;
  denyRisk: number;
  askRisk: number;
}

export interface PolicyDecision {
  verdict: Verdict;
  reason?: string;
  trigger?: keyof GuardSignals;
}

const NOUL_KEYS = ['destructive', 'secrets', 'exfiltration', 'outsideWorkspace'] as const;

export const DEFAULT_THRESHOLDS: Thresholds = {
  denyNoul: 0.85,
  askNoul: 0.5,
  denyRisk: 2.5,
  askRisk: 1.5,
};

export function decide(
  signals: GuardSignals,
  _agent: AgentKind,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): PolicyDecision {
  let trigger: keyof GuardSignals = NOUL_KEYS[0];
  let maxNoul = signals[trigger];
  for (const key of NOUL_KEYS.slice(1)) {
    if (signals[key] > maxNoul) {
      maxNoul = signals[key];
      trigger = key;
    }
  }
  if (signals.risk >= thresholds.denyRisk && signals.risk >= maxNoul) trigger = 'risk';
  if (maxNoul >= thresholds.denyNoul || signals.risk >= thresholds.denyRisk) {
    const probability = trigger === 'risk' ? signals.risk : signals[trigger];
    return {
      verdict: 'deny',
      trigger,
      reason: `Jev Guard: ${trigger} (p=${probability.toFixed(2)}, risk=${signals.risk.toFixed(1)}). This action was blocked.`,
    };
  }
  if (maxNoul >= thresholds.askNoul || signals.risk >= thresholds.askRisk) {
    if (signals.risk >= thresholds.askRisk && signals.risk >= maxNoul) trigger = 'risk';
    const probability = trigger === 'risk' ? signals.risk : signals[trigger];
    return {
      verdict: 'ask',
      trigger,
      reason: `Jev Guard: ${trigger} (p=${probability.toFixed(2)}, risk=${signals.risk.toFixed(1)}). Ask the user to confirm before retrying.`,
    };
  }
  return { verdict: 'allow' };
}
