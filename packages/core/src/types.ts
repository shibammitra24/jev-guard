export type AgentKind = 'agy' | 'claude';
export type Verdict = 'allow' | 'ask' | 'deny';

export interface NormalizedToolCall {
  agent: AgentKind;
  tool: string;
  args: Record<string, unknown>;
  workspace?: string;
  conversationId?: string;
  raw: unknown;
}

export interface GuardSignals {
  destructive: number;
  secrets: number;
  exfiltration: number;
  outsideWorkspace: number;
  risk: number;
}

export interface GuardDecision {
  verdict: Verdict;
  reason?: string;
  signals?: GuardSignals;
  trigger?: keyof GuardSignals;
  latencyMs: number;
  source: 'jev' | 'prefilter' | 'fallback' | 'disabled';
}

export interface DecisionRecord extends Omit<GuardDecision, 'reason'> {
  ts: string;
  agent: AgentKind;
  tool: string;
  argsRedacted: Record<string, unknown>;
  reason?: string;
}

export type JevQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: readonly string[] };

export interface NoulAnswer { type: 'noul'; noul: number }
export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
export interface ScoreAnswer {
  type: 'score';
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
}
export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export interface NormalizedJevAnswer {
  value: number | string;
  confidence: number;
  probabilities?: Record<string, number>;
  type: JevAnswer['type'];
}
export interface JevAnswers {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export type JevErrorKind = 'auth' | 'timeout' | 'network' | 'http' | 'parse';
export class JevError extends Error {
  readonly kind: JevErrorKind;
  readonly status?: number;
  constructor(kind: JevErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'JevError';
    this.kind = kind;
    this.status = status;
  }
}
