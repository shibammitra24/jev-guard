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

  /**
   * Take over the tab Chrome opened at launch instead of creating a second one,
   * so the user sees exactly one window with one tab. Any other page targets are
   * closed. Falls back to create() only when Chrome has no page target at all.
   */
  static async open(cdp: CdpTransport, workspace: string, url: string): Promise<BrowserSession> {
    const initialUrl = normalizeInitialUrl(url);
    // Chrome's startup tab can appear a moment after the debugging port opens;
    // creating our own tab in that gap would leave the user with two.
    let pages = await pageTargets(cdp);
    for (let attempt = 0; !pages.length && attempt < 20; attempt += 1) {
      await sleep(100);
      pages = await pageTargets(cdp);
    }
    const page = pages.find(target => sameUrl(target.url, initialUrl)) ?? pages[0];
    let session: BrowserSession;
    if (!page) {
      session = await BrowserSession.create(cdp, workspace, initialUrl);
    } else {
      for (const extra of pages) {
        if (extra.targetId !== page.targetId) await cdp.call('Target.closeTarget', { targetId: extra.targetId }).catch(() => undefined);
      }
      const attached = await cdp.call<{ sessionId: string }>('Target.attachToTarget', { targetId: page.targetId, flatten: true });
      await cdp.call('Page.enable', {}, attached.sessionId);
      await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true }, attached.sessionId);
      session = new BrowserSession(cdp, page.targetId, attached.sessionId, workspace);
    }
    await session.installPageHelper();
    // Chrome is launched on about:blank so the helper is installed before the
    // first real document and its request tracking sees the very first fetch.
    // If the tab is somehow already on initialUrl, just let it finish loading.
    const current = await session.pageState();
    if (current && sameUrl(current.url, initialUrl)) {
      try {
        await session.waitForLoad();
        await session.settle(8000, 800);
        return session;
      } catch { /* fall through to an explicit navigation */ }
    }
    await session.goto(initialUrl, true);
    return session;
  }

  /**
   * Navigate this tab to a URL and wait until the new document has loaded and
   * its DOM has stopped changing. A no-op when the tab is already on that URL.
   */
  async goto(url: string, force = false): Promise<void> {
    this.assertOpen();
    const target = normalizeInitialUrl(url);
    const before = await this.pageState();
    if (!force && before && sameUrl(before.url, target) && before.ready === 'complete') {
      await this.settle();
      return;
    }
    const result = await this.cdp.call<{ loaderId?: string; errorText?: string }>('Page.navigate', { url: target }, this.sessionId);
    if (result?.errorText) throw new BrowserSessionError(`Could not open ${target}: ${result.errorText}`);
    await this.waitForLoad(result?.loaderId ? before?.origin : undefined);
    // A freshly opened page gets a longer quiet window: client-rendered sites
    // often fetch their real content only after the load event.
    await this.settle(8000, 800);
  }

  /**
   * Wait for the page to be usable. `previousOrigin` (performance.timeOrigin of
   * the old document) makes sure a navigation really replaced the document
   * rather than reading the old page's "complete" state.
   */
  async waitForLoad(previousOrigin?: number, timeoutMs = 20_000): Promise<void> {
    const started = Date.now();
    let last: PageState | undefined;
    while (Date.now() - started < timeoutMs) {
      last = await this.pageState();
      const replaced = previousOrigin === undefined || (last !== undefined && last.origin !== previousOrigin);
      if (last && replaced && !isStartupUrl(last.url) && last.ready === 'complete') return;
      await sleep(100);
    }
    // Slow third-party resources can hold readyState at "interactive" forever;
    // a parsed document is still usable. Only a page that never arrived fails.
    if (last && !isStartupUrl(last.url) && last.ready !== 'loading') return;
    throw new BrowserSessionError(`Browser page did not finish loading${last ? `: ${last.url}` : ''}`);
  }

  /**
   * Wait until the page stops changing: no recent fetch/XHR in flight and the
   * same URL, readyState, control count and (coarse) text length for `quietMs`.
   * Client-rendered pages keep building their UI long after "load"; observing
   * earlier gives the model a half-rendered page, which is why a task could
   * fail once and pass on retry.
   */
  async settle(maxMs = 5000, quietMs = 450): Promise<void> {
    this.assertOpen();
    const started = Date.now();
    let last = '';
    let stableSince = 0;
    while (Date.now() - started < maxMs) {
      let signature = '';
      try {
        const result = await this.cdp.call<{ result?: { value?: unknown } }>(
          'Runtime.evaluate', { expression: SETTLE_PROBE, returnByValue: true }, this.sessionId,
        );
        const value = result?.result?.value;
        if (typeof value !== 'string') return; // page cannot be probed; observe() still fails closed
        signature = value;
      } catch {
        signature = ''; // execution context replaced mid-navigation
      }
      const quiet = signature !== '' && !signature.startsWith('loading') && signature.endsWith('|0');
      if (quiet && signature === last) {
        if (Date.now() - stableSince >= quietMs) return;
      } else {
        stableSince = Date.now();
      }
      last = signature;
      await sleep(150);
    }
  }

  /**
   * Call after every executed action: gives a click time to start navigating,
   * pulls any popup/new tab back into this tab, and waits for the page to settle.
   */
  async afterAction(action?: ObservedAction): Promise<void> {
    this.assertOpen();
    if (action?.kind === 'wait' || action?.kind === 'scroll') return; // perform() already settled
    await sleep(250);
    await this.adoptPopups();
    const state = await this.pageState();
    if (state && state.ready !== 'complete') await this.waitForLoad(undefined, 15_000).catch(() => undefined);
    await this.settle();
  }

  /** Keep the session to one tab: close any new tab and open its URL here instead. */
  private async adoptPopups(): Promise<void> {
    const extras = (await pageTargets(this.cdp)).filter(target => target.targetId !== this.targetId);
    if (!extras.length) return;
    const url = extras.map(target => target.url).reverse().find(value => /^https?:/i.test(value));
    for (const extra of extras) await this.cdp.call('Target.closeTarget', { targetId: extra.targetId }).catch(() => undefined);
    await this.cdp.call('Target.activateTarget', { targetId: this.targetId }).catch(() => undefined);
    if (url) await this.goto(url);
  }

  /** Installs PAGE_HELPER_SCRIPT in this document and every later one. */
  private async installPageHelper(): Promise<void> {
    await this.cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_HELPER_SCRIPT }, this.sessionId).catch(() => undefined);
    await this.cdp.call('Runtime.evaluate', { expression: PAGE_HELPER_SCRIPT }, this.sessionId).catch(() => undefined);
  }

  private async pageState(): Promise<PageState | undefined> {
    try {
      const state = await this.cdp.call<{ result?: { value?: PageState } }>(
        'Runtime.evaluate',
        { expression: '({ready:document.readyState,url:location.href,origin:performance.timeOrigin})', returnByValue: true },
        this.sessionId,
      );
      return state?.result?.value;
    } catch {
      return undefined; // context is being replaced by a navigation
    }
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
      // A real wait: give pending requests time, then wait for the DOM to settle.
      await sleep(500);
      await this.settle(3000);
      return;
    }

    if (action.kind === 'scroll') {
      // Scroll the document itself (the snapshot only offers scroll when the
      // document can scroll), independent of window size or mouse position.
      const direction = action.id === 'scroll_up' ? -1 : 1;
      await this.cdp.call(
        'Runtime.evaluate',
        { expression: `window.scrollBy({ top: ${direction} * Math.round(innerHeight * 0.8), left: 0, behavior: 'instant' })` },
        this.sessionId,
      );
      await this.settle(1500); // lazy-loaded content below the fold
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

interface PageState { ready: string; url: string; origin: number; }
interface TargetInfo { targetId: string; type: string; url: string; }

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Cheap "is the page still changing" probe; text length is coarse so tickers
 * don't count. The last field counts fetch/XHR requests started in the past 3 s
 * and still pending (older ones are long-polls or analytics that never finish).
 */
const SETTLE_PROBE = String.raw`(() => {
  const controls = document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[role="combobox"]').length;
  const text = Math.round((document.body?.innerText.length ?? 0) / 200);
  const now = performance.now();
  const busy = window.__jevRequests ? [...window.__jevRequests.values()].filter(start => now - start < 3000).length : 0;
  return document.readyState + '|' + location.href + '|' + controls + '|' + text + '|' + busy;
})()`;

/**
 * Keeps the session to one tab (target=_blank links/forms and window.open()
 * navigate this tab) and records in-flight fetch/XHR for settle().
 */
const PAGE_HELPER_SCRIPT = String.raw`(() => {
  if (window.__jevOneTab) return;
  window.__jevOneTab = true;
  const requests = window.__jevRequests = new Map();
  let nextRequest = 0;
  const track = () => { const key = ++nextRequest; requests.set(key, performance.now()); return () => requests.delete(key); };
  const nativeFetch = window.fetch;
  if (nativeFetch) window.fetch = function (...args) { const done = track(); return nativeFetch.apply(this, args).finally(done); };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) { this.addEventListener('loadend', track(), { once: true }); return send.apply(this, args); };
  const sameTab = event => {
    const el = event.target instanceof Element ? event.target.closest('a[target],area[target],form[target]') : null;
    if (el && el.getAttribute('target') !== '_self') el.setAttribute('target', '_self');
  };
  document.addEventListener('click', sameTab, true);
  document.addEventListener('submit', sameTab, true);
  const open = window.open;
  window.open = function (url, name, features) {
    if (url && name !== '_self') { location.assign(new URL(String(url), location.href).href); return null; }
    return open.call(window, url, name, features);
  };
})()`;

async function pageTargets(cdp: CdpTransport): Promise<TargetInfo[]> {
  const result = await cdp.call<{ targetInfos?: TargetInfo[] }>('Target.getTargets').catch(() => undefined);
  return (result?.targetInfos ?? []).filter(target => target.type === 'page');
}

/** Startup placeholders Chrome shows before (or instead of) the requested page. */
function isStartupUrl(url: string): boolean {
  return url === '' || url === 'about:blank' || /^(chrome|edge|chrome-search):/i.test(url);
}

function sameUrl(a: string, b: string): boolean {
  const clean = (value: string) => {
    try {
      const url = new URL(value);
      url.hash = '';
      return url.href.replace(/\/$/, '');
    } catch {
      return value;
    }
  };
  return clean(a) === clean(b);
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
