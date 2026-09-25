import type { BrowserAction, GuardedBrowserRequest, GuardedBrowserResponse } from 'jev-core';
import { parseBrowserRequest } from 'jev-core';
import { assertFresh } from './freshness.js';
import { guardBrowserAction } from './guard-client.js';
import { SNAPSHOT_SCRIPT } from './snapshot.js';
import type { BrowserSnapshot, ObservedAction } from './types.js';
import type { CdpTransport } from './cdp.js';

export interface GuardEndpoint { endpoint: string; token: string; }
export interface ExecutionResult { executed: boolean; decision: GuardedBrowserResponse; }
export interface ExecuteOptions {
  confirmed?: boolean;
  confirm?: (decision: GuardedBrowserResponse, action: ObservedAction) => Promise<boolean>;
  fetcher?: typeof fetch;
}

/** Thrown when the session is in an unrecoverable state and must be closed. */
export class BrowserSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserSessionError';
  }
}

export class BrowserSession {
  /** Set to true after close() — all further operations throw BrowserSessionError. */
  private closed = false;

  constructor(
    private readonly cdp: CdpTransport,
    readonly targetId: string,
    readonly sessionId: string,
    readonly workspace: string,
  ) {}

  static async create(cdp: CdpTransport, workspace: string, url = 'about:blank'): Promise<BrowserSession> {
    // Create the target at its final URL.  Doing this rather than creating an
    // about:blank target followed by Page.navigate avoids a Chromium race where
    // a newly-created visible target rejects that second navigation as invalid.
    const initialUrl = normalizeInitialUrl(url);
    const target = await cdp.call<{ targetId: string }>('Target.createTarget', { url: initialUrl, background: false });
    const attached = await cdp.call<{ sessionId: string }>('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await cdp.call('Page.enable', {}, attached.sessionId);
    await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true }, attached.sessionId);
    if (initialUrl !== 'about:blank') {
      let loaded = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const state = await cdp.call<{ result?: { value?: { ready: string; url: string } } }>(
          'Runtime.evaluate',
          { expression: '({ready:document.readyState,url:location.href})', returnByValue: true },
          attached.sessionId,
        );
        if (state.result?.value?.ready === 'complete' && state.result.value.url !== 'about:blank') {
          loaded = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!loaded) throw new BrowserSessionError(`Browser page did not finish loading: ${initialUrl}`);
    }
    return new BrowserSession(cdp, target.targetId, attached.sessionId, workspace);
  }

  /** Take an atomic DOM snapshot. Fails closed if the page cannot be observed. */
  async observe(): Promise<BrowserSnapshot> {
    this.assertOpen();
    // A click can briefly leave Chromium between DOM commits (especially when
    // an SPA updates a live region). Retry observation without retrying the
    // action itself. This prevents a successful click from being reported as
    // a failed browser goal while preserving fail-closed behaviour.
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const result = await this.cdp.call<{ result?: { value?: BrowserSnapshot }; exceptionDetails?: unknown }>(
          'Runtime.evaluate',
          { expression: SNAPSHOT_SCRIPT, returnByValue: true },
          this.sessionId,
        );
        if (!result.exceptionDetails && result.result?.value) return result.result.value;
        lastError = result.exceptionDetails;
      } catch (error) {
        lastError = error;
      }
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 75 * (attempt + 1)));
    }
    const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
    throw new BrowserSessionError(`Could not observe browser page — failing closed${detail}`);
  }

  /** Navigate to a URL and wait for the page to finish loading. */
  async navigate(url: string): Promise<void> {
    this.assertOpen();
    await this.cdp.call('Page.navigate', { url }, this.sessionId);
  }

  /**
   * Execute one observed action through the guard + CDP pipeline.
   *
   * Order of operations (fail-closed at every step):
   *   1. Re-observe to get the live fingerprint.
   *   2. Assert freshness against the snapshot used for the decision.
   *   3. Build and validate a GuardedBrowserRequest (Phase 1 contract).
   *   4. Send to the guard daemon (skip for prefiltered scroll/wait).
   *   5. If denied → return without mutating CDP.
   *   6. If ask and not confirmed → return without mutating CDP.
   *   7. Re-observe and assert freshness a second time immediately before mutation.
   *   8. Perform the CDP mutation.
   *   9. Return the result.
   */
  async execute(
    action: ObservedAction,
    observed: BrowserSnapshot,
    guard: GuardEndpoint,
    options: ExecuteOptions = {},
  ): Promise<ExecutionResult> {
    this.assertOpen();

    // Step 1 + 2: freshness check before contacting the guard
    assertFresh(observed, (await this.observe()).fingerprint);

    // Step 3: build and validate the request through the Phase 1 contract
    const browserAction: BrowserAction = {
      id: action.id,
      kind: action.kind,
      label: action.label,
      value: action.optionValue ?? action.value,
      url: action.kind === 'navigate' ? action.value : undefined,
      pageFingerprint: observed.fingerprint,
      workspace: this.workspace,
    };
    const rawRequest = {
      workspace: this.workspace,
      provenance: 'browser-sidecar' as const,
      page: { url: observed.url, title: observed.title, visibleText: observed.visibleText },
      action: browserAction,
    };
    // parseBrowserRequest throws BrowserContractError on any violation — fail closed
    const request: GuardedBrowserRequest = parseBrowserRequest(rawRequest);

    // Step 4: guard decision (scroll and wait are prefiltered)
    const decision: GuardedBrowserResponse =
      action.kind === 'wait' || action.kind === 'scroll'
        ? { decision: 'allow', latencyMs: 0 }
        : await guardBrowserAction(guard.endpoint, guard.token, request, options.fetcher);

    // Step 5: deny → no CDP mutation
    if (decision.decision === 'deny') return { executed: false, decision };

    // Step 6: ask → must be confirmed, otherwise no CDP mutation
    if (
      decision.decision === 'ask' &&
      !options.confirmed &&
      !(options.confirm && await options.confirm(decision, action))
    ) {
      return { executed: false, decision };
    }

    // Step 7: second freshness check immediately before mutation
    assertFresh(observed, (await this.observe()).fingerprint);

    // Step 8: CDP mutation
    await this.perform(action);
    return { executed: true, decision };
  }

  /** Close the CDP target and the underlying WebSocket. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.cdp.call('Target.closeTarget', { targetId: this.targetId });
    } finally {
      this.cdp.close();
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new BrowserSessionError('BrowserSession has been closed');
  }

  private async perform(action: ObservedAction): Promise<void> {
    if (action.kind === 'wait') {
      await new Promise(resolve => setTimeout(resolve, 100));
      return;
    }

    if (action.kind === 'scroll') {
      await this.cdp.call(
        'Input.dispatchMouseEvent',
        { type: 'mouseWheel', x: 550, y: 650, deltaX: 0, deltaY: action.id === 'scroll_up' ? -560 : 560 },
        this.sessionId,
      );
      return;
    }

    if (action.kind === 'navigate') {
      if (!action.value) throw new BrowserSessionError('Navigation requires a URL');
      await this.navigate(action.value);
      return;
    }

    if (action.kind === 'submit') {
      // Fire the form's submit event through JS — no direct CDP form submission API.
      // We resolve the DOM node cached in __jevFast and call requestSubmit() so that
      // validation and submit-event listeners run (unlike .submit()).
      const expression = `(node => {
        const e = window.__jevFast?.nodes.get(node);
        if (!e) return false;
        const form = e.tagName === 'FORM' ? e : e.closest('form') ?? e.form;
        if (!form) { e.click(); return true; }
        if (typeof form.requestSubmit === 'function') { form.requestSubmit(e.tagName !== 'FORM' ? e : null); return true; }
        form.submit(); return true;
      })(${JSON.stringify(action.node ?? null)})`;
      const result = await this.cdp.call<{ result?: { value?: boolean } }>(
        'Runtime.evaluate',
        { expression, returnByValue: true },
        this.sessionId,
      );
      if (!result.result?.value) throw new BrowserSessionError('Submit target not found or is not connected');
      return;
    }

    // click / fill / select — resolve the cached DOM node and dispatch input events
    const expression = `(action => {
      const e = window.__jevFast?.nodes.get(action.node);
      if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
          !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (!r.width || !r.height || !e.contains(document.elementFromPoint(x, y))) return false;
      if (action.kind === 'select') {
        e.value = action.optionValue;
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      if (action.kind === 'fill') {
        e.focus();
        e.value = '';
        e.dispatchEvent(new Event('input', { bubbles: true }));
        return { x, y };
      }
      return { x, y };
    })(${JSON.stringify(action)})`;

    const result = await this.cdp.call<{ result?: { value?: boolean | { x: number; y: number } } }>(
      'Runtime.evaluate',
      { expression, returnByValue: true },
      this.sessionId,
    );
    const target = result.result?.value;
    if (!target) throw new BrowserSessionError('Browser target changed or is covered');
    if (action.kind === 'select') return;

    const point = target as { x: number; y: number };
    if (action.kind === 'fill') {
      await this.cdp.call('Input.insertText', { text: action.value ?? '' }, this.sessionId);
      return;
    }

    // click — mousePressed + mouseReleased
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.cdp.call(
        'Input.dispatchMouseEvent',
        { type, x: point.x, y: point.y, button: 'left', clickCount: 1 },
        this.sessionId,
      );
    }
  }
}

function normalizeInitialUrl(value: string): string {
  if (value === 'about:blank') return value;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
    return url.href;
  } catch {
    throw new BrowserSessionError(`Browser startup requires an absolute http(s) URL, received: ${JSON.stringify(value)}`);
  }
}
