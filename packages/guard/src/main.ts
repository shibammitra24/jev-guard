import { CORE_VERSION, GUARD_QUESTIONS, buildGuardState, decide, prefilter, redact, type GuardDecision, type JevAnswers, type NormalizedToolCall } from 'jev-core';
import { loadApiKey } from './credentials';
import { loadConfig, type GuardConfig } from './config';
import { createLogger, type DecisionLogger } from './log';
import { agyAdapter, isBrowserTool } from './adapters/agy';
import { runBrowserBridge, type BrowserBridgeEndpoint } from './adapters/browser-bridge';

const MAX_STDIN = 1024 * 1024;
const WATCHDOG_MS = 4000;

export interface RunDeps {
  config?: GuardConfig;
  logger?: DecisionLogger;
  apiKey?: string;
  ask?: typeof import('jev-core')['ask'];
  now?: () => number;
  homeDir?: string;
  watchdogMs?: number;
  /**
   * Loopback endpoint for the browser sidecar daemon.
   * When null or omitted, browser_subagent calls are denied with an explanation.
   * When provided, the call is forwarded via the deny-and-retry bridge.
   *
   * See docs/host-behaviour.md — Phase 0 gate — for why transparent result
   * substitution is not possible through the PreToolUse hook.
   */
  browserBridge?: BrowserBridgeEndpoint | null;
  /** Injectable fetch for the browser bridge (used in tests). */
  bridgeFetcher?: typeof fetch;
}

export function fallbackDecision(reason = 'Jev Guard unavailable; ask the user before retrying.'): GuardDecision {
  return { verdict: 'ask', reason, latencyMs: 0, source: 'fallback' };
}

export function signalsFromAnswers(answers: JevAnswers) {
  const value = (name: string): number => {
    const answer = answers.answers[name];
    if (!answer || answer.type !== 'noul' || !Number.isFinite(answer.noul)) {
      throw new Error('Missing or invalid noul answer: ' + name);
    }
    return answer.noul;
  };
  const risk = answers.answers.risk;
  if (!risk || risk.type !== 'score' || !Number.isFinite(risk.score)) {
    throw new Error('Missing or invalid score answer: risk');
  }
  return {
    destructive: value('destructive'),
    secrets: value('secrets'),
    exfiltration: value('exfiltration'),
    outsideWorkspace: value('outsideWorkspace'),
    risk: risk.score,
  };
}

function record(call: NormalizedToolCall | undefined, decision: GuardDecision): Record<string, unknown> | undefined {
  if (!call) return undefined;
  return {
    ts: new Date().toISOString(),
    agent: call.agent,
    tool: call.tool,
    argsRedacted: redact(call.args),
    ...decision,
  };
}

// ---------------------------------------------------------------------------
// Normal-tool evaluation path (unchanged)
// ---------------------------------------------------------------------------

async function evaluate(
  call: NormalizedToolCall,
  config: GuardConfig,
  apiKey: string,
  ask: typeof import('jev-core')['ask'],
  now: () => number,
): Promise<GuardDecision> {
  const started = now();
  if (!config.enabled) return { verdict: 'allow', latencyMs: now() - started, source: 'disabled' };
  if (prefilter(call, config.prefilterTools) === 'allow') return { verdict: 'allow', latencyMs: now() - started, source: 'prefilter' };
  const answers = await ask(buildGuardState(call), GUARD_QUESTIONS, {
    apiKey,
    timeoutMs: config.timeoutMs,
  });
  const decision = decide(signalsFromAnswers(answers), call.agent, config.thresholds);
  return { ...decision, latencyMs: now() - started, source: 'jev' };
}

// ---------------------------------------------------------------------------
// Main guard entry point — branches on tool classification
// ---------------------------------------------------------------------------

export async function runGuard(input: string, argv: string[] = ['--agent', 'agy'], deps: RunDeps = {}): Promise<string> {
  const agent = argv[argv.indexOf('--agent') + 1] ?? 'agy';
  const config = deps.config ?? loadConfig(deps.homeDir);
  const logger = deps.logger ?? createLogger(config.logPath);
  const now = deps.now ?? (() => Date.now());
  let call: NormalizedToolCall | undefined;
  let decision: GuardDecision;

  try {
    if (agent !== 'agy') throw new Error('Unsupported agent: ' + agent);
    const payload = JSON.parse(input) as unknown;
    call = agyAdapter.parse(payload);

    // -----------------------------------------------------------------------
    // Branch: browser tool call → deny-and-retry bridge
    // Branch: normal tool call  → existing Jev Guard path
    //
    // The bridge path is documented in docs/host-behaviour.md.
    // isBrowserTool() returns true for 'browser_subagent' only.
    // -----------------------------------------------------------------------
    if (isBrowserTool(call)) {
      // Bridge path — watchdog still applies
      const bridgeWork = runBrowserBridge(
        call,
        deps.browserBridge ?? null,
        { fetcher: deps.bridgeFetcher, now },
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<GuardDecision>((resolve) => {
        timer = setTimeout(
          () => resolve(fallbackDecision('Jev Guard: browser sidecar timed out; browser task was not executed.')),
          deps.watchdogMs ?? WATCHDOG_MS,
        );
      });
      decision = await Promise.race([bridgeWork, timeout]);
      if (timer) clearTimeout(timer);
    } else {
      // Normal tool path — unchanged
      const needsJev = config.enabled && prefilter(call, config.prefilterTools) === 'check';
      const apiKey = needsJev ? (deps.apiKey ?? loadApiKey(process.env, deps.homeDir)) : '';
      const ask = deps.ask ?? (await import('jev-core')).ask;
      const work = evaluate(call, config, apiKey, ask, now);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<GuardDecision>((resolve) => {
        timer = setTimeout(
          () => resolve(fallbackDecision('Jev Guard timed out; ask the user before retrying.')),
          deps.watchdogMs ?? WATCHDOG_MS,
        );
      });
      decision = await Promise.race([work, timeout]);
      if (timer) clearTimeout(timer);
    }
  } catch (error) {
    decision = fallbackDecision(
      error instanceof Error && (error.message.includes('API key') || error.message.includes('API_KEY'))
        ? 'Jev Guard has no API key; ask the user before retrying.'
        : undefined,
    );
  }

  const entry = record(call, decision);
  if (entry) logger.append(entry);
  return agyAdapter.render(decision);
}

// ---------------------------------------------------------------------------
// Stdio entry point
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => reject(new Error('stdin read timed out')), 2000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
      if (Buffer.byteLength(data, 'utf8') > MAX_STDIN) {
        clearTimeout(timer);
        reject(new Error('stdin payload exceeds 1 MB'));
        process.stdin.destroy();
      }
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function main(): Promise<void> {
  let output: string;
  try {
    output = await runGuard(await readStdin(), process.argv.slice(2));
  } catch {
    output = JSON.stringify({ decision: 'deny', reason: 'Jev Guard could not read the tool call; action blocked safely.' });
  }
  process.stdout.write(output + '\n');
}

if (require.main === module) {
  void main().catch(() => {
    process.stdout.write('{"decision":"deny","reason":"Jev Guard failed closed; action blocked safely."}\n');
  });
}

export { CORE_VERSION };
