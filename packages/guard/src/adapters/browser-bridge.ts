/**
 * Deny-and-retry browser bridge for the PreToolUse hook.
 *
 * Because Antigravity's PreToolUse hook cannot inject a synthetic tool result
 * (documented in docs/host-behaviour.md, Phase 0 gate), transparent interception
 * of browser_subagent is not possible.  Instead the bridge:
 *
 *   1. Validates that a guard daemon is reachable for the requested workspace.
 *   2. Forwards the Task string (and workspace) to the daemon's /v1/browser/task endpoint.
 *   3. Returns { verdict: 'deny', reason: <sidecar result> } so the agent receives
 *      the browser result through the hook's denial-reason channel.
 *
 * Limitation: the agent sees the result as a denial reason rather than a
 * successful tool return.  This is the documented Phase 0 limitation and must
 * not be presented as transparent browser integration.
 */
import type { GuardDecision, NormalizedToolCall } from 'jev-core';

export interface BrowserBridgeEndpoint {
  /** Full loopback URL of the guard daemon, e.g. http://127.0.0.1:4312 */
  endpoint: string;
  /** Per-session random token issued by startGuardServer(). */
  token: string;
  /** Absolute workspace path — must match what the daemon was started with. */
  workspace: string;
}

export interface BrowserBridgeDeps {
  /** Injectable fetch for testing. Defaults to globalThis.fetch. */
  fetcher?: typeof fetch;
  /** Injectable Date.now() for testing. */
  now?: () => number;
}

/**
 * Sentinel decision returned when no bridge endpoint is configured.
 * Denies the browser call and explains why the sidecar is unavailable.
 */
export function noBridgeDecision(): GuardDecision {
  return {
    verdict: 'deny',
    reason:
      'Jev Guard: no browser sidecar is running for this workspace. ' +
      'Start the sidecar from the extension before issuing browser commands.',
    latencyMs: 0,
    source: 'fallback',
  };
}

/**
 * Sentinel decision returned when the workspace in the tool call does not match
 * the sidecar's registered workspace — cross-workspace browser calls are always denied.
 */
export function workspaceMismatchDecision(callWorkspace: string, bridgeWorkspace: string): GuardDecision {
  return {
    verdict: 'deny',
    reason:
      `Jev Guard: browser sidecar workspace mismatch ` +
      `(call workspace "${callWorkspace}" ≠ sidecar workspace "${bridgeWorkspace}"). ` +
      'Browser actions are only permitted in the workspace where the sidecar was started.',
    latencyMs: 0,
    source: 'jev',
  };
}

/**
 * Route a browser_subagent tool call through the deny-and-retry bridge.
 *
 * Returns a GuardDecision whose verdict is always 'deny' (carrying the sidecar
 * result as the reason) or 'ask'/'deny' from the daemon's own guard evaluation.
 * The caller (runGuard) renders this decision as normal.
 *
 * @param call       - The normalized browser_subagent tool call from the hook.
 * @param bridge     - Loopback endpoint config; null when no sidecar is running.
 * @param deps       - Injectable dependencies for testing.
 */
export async function runBrowserBridge(
  call: NormalizedToolCall,
  bridge: BrowserBridgeEndpoint | null,
  deps: BrowserBridgeDeps = {},
): Promise<GuardDecision> {
  const now = deps.now ?? (() => Date.now());
  const fetcher = deps.fetcher ?? globalThis.fetch;
  const started = now();

  // No sidecar configured
  if (!bridge) return noBridgeDecision();

  // Workspace mismatch — deny immediately without contacting the sidecar
  const callWorkspace = call.workspace ?? '';
  if (callWorkspace && callWorkspace !== bridge.workspace) {
    return workspaceMismatchDecision(callWorkspace, bridge.workspace);
  }

  // Extract the browser Task from the tool call arguments
  const task = typeof call.args['Task'] === 'string' ? call.args['Task'] : '';
  const taskName = typeof call.args['TaskName'] === 'string' ? call.args['TaskName'] : 'browser task';

  let sidecaResult: string;
  try {
    const response = await fetcher(`${bridge.endpoint.replace(/\/$/, '')}/v1/browser/task`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bridge.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ task, taskName, workspace: bridge.workspace }),
    });

    if (!response.ok) {
      // Sidecar returned an error — fail closed
      return {
        verdict: 'deny',
        reason:
          `Jev Guard: browser sidecar returned HTTP ${response.status} for "${taskName}". ` +
          'The browser task was not executed.',
        latencyMs: now() - started,
        source: 'fallback',
      };
    }

    const body = (await response.json()) as { result?: string; error?: string };
    sidecaResult = body.result ?? body.error ?? 'Browser task completed (no result returned).';
  } catch (error) {
    // Network failure — fail closed
    return {
      verdict: 'deny',
      reason:
        `Jev Guard: could not reach the browser sidecar (${error instanceof Error ? error.message : 'network error'}). ` +
        'The browser task was not executed.',
      latencyMs: now() - started,
      source: 'fallback',
    };
  }

  // Return the sidecar result encoded as a denial reason.
  // The agent receives this through the hook's reason channel.
  // This is the documented Phase 0 limitation — not transparent integration.
  return {
    verdict: 'deny',
    reason: `[browser-sidecar] ${sidecaResult}`,
    latencyMs: now() - started,
    source: 'jev',
  };
}
