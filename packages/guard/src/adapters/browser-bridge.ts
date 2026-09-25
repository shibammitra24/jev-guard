/**
 * Deny-and-retry browser bridge for the PreToolUse hook.
 *
 * Because Antigravity's PreToolUse hook cannot inject a synthetic tool result
 * (documented in docs/host-behaviour.md, Phase 0 gate), transparent interception
 * of browser_subagent is not possible.  Instead the bridge:
 *
 *   1. Validates that a guard daemon is reachable for the requested workspace.
 *   2. Forwards the Task string (and workspace) to the daemon's /v1/browser/task endpoint.
 *   3. Returns { verdict: 'deny', source: 'browser', reason: <sidecar result> } so
 *      the agent receives the browser result through the hook's reason channel.
 *      The agy adapter renders source 'browser' as task output, not as a block.
 *
 * Limitation: the host still delivers the text through its denial channel
 * rather than as a successful tool return (documented Phase 0 limitation).
 */
import type { GuardDecision, NormalizedToolCall } from 'jev-core';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isSameWorkspace } from '../security';

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

/** The extension publishes this short-lived, token-protected loopback record. */
export function browserBridgeConfigPath(workspace: string): string {
  return join(resolve(workspace), '.jev', 'browser-sidecar.json');
}

/**
 * Read a bridge registration for exactly one workspace.  Invalid files and
 * non-loopback endpoints are ignored so a hook never sends a task elsewhere.
 */
export function loadBrowserBridge(workspace: string | undefined): BrowserBridgeEndpoint | null {
  if (!workspace) return null;
  const path = browserBridgeConfigPath(workspace);
  try {
    if (!existsSync(path)) return null;
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<BrowserBridgeEndpoint>;
    if (
      typeof value.endpoint !== 'string' ||
      typeof value.token !== 'string' || !value.token ||
      typeof value.workspace !== 'string' ||
      !isSameWorkspace(value.workspace, workspace)
    ) return null;
    const url = new URL(value.endpoint);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
    return { endpoint: value.endpoint, token: value.token, workspace: value.workspace };
  } catch {
    return null;
  }
}

/** Allow extension activation and hook invocation to converge without a race. */
export async function waitForBrowserBridge(
  workspace: string | undefined,
  timeoutMs = 2_000,
): Promise<BrowserBridgeEndpoint | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const bridge = loadBrowserBridge(workspace);
    if (bridge) return bridge;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return loadBrowserBridge(workspace);
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
      'Open this workspace in VS Code with the Jev Guard extension enabled, then retry the browser request.',
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
  if (callWorkspace && !isSameWorkspace(callWorkspace, bridge.workspace)) {
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

  // The deny verdict is only the transport for the result text (documented
  // Phase 0 limitation); source 'browser' lets the adapter render it as output.
  return {
    verdict: 'deny',
    reason: sidecaResult,
    latencyMs: now() - started,
    source: 'browser',
  };
}
