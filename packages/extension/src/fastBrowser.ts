import { BrowserSession, CdpConnection, createJevBrowserDecider, runBrowserGoal, type BrowserDecision, type BrowserGoalResult, type BrowserSnapshot, type CdpTransport, type GuardEndpoint, type ObservedAction } from 'jev-fast-browser';
import { startGuardServer, type GuardServer } from 'jev-guard-cli/server';
import { browserBridgeConfigPath } from 'jev-guard-cli/adapters/browser-bridge';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

export interface FastBrowserStatus {
  running: boolean;
  workspace?: string;
  endpoint?: string;
  targetId?: string;
  protocolCalls: number;
  screenshots: number;
  jevRequests: number;
  lastGoalStatus?: string;
  pageUrl?: string;
  observedActions?: number;
  completedGoals: number;
  blockedGoals: number;
  failedGoals: number;
}

class CountingTransport implements CdpTransport {
  protocolCalls = 0;
  screenshots = 0;
  constructor(private readonly inner: CdpTransport) {}
  call<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> {
    this.protocolCalls += 1;
    if (method === 'Page.captureScreenshot') this.screenshots += 1;
    return this.inner.call<T>(method, params, sessionId);
  }
  close(): void { this.inner.close(); }
}

export class FastBrowserController {
  private guard?: GuardServer;
  private session?: BrowserSession;
  private transport?: CountingTransport;
  private workspace?: string;
  private endpoint?: string;
  private jevRequests = 0;
  private lastGoalStatus?: string;
  private lastSnapshot?: BrowserSnapshot;
  private completedGoals = 0;
  private blockedGoals = 0;
  private failedGoals = 0;
  private browserProcess?: ChildProcess;
  private browserProfile?: string;
  private bridgeWorkspace?: string;
  private taskBusy = false;

  /**
   * Start the lightweight, workspace-scoped control endpoint. This does not
   * launch Chrome. Chrome only starts when Antigravity actually requests the
   * browser tool.
   */
  async activateBridge(workspace: string, apiKey: () => Promise<string | undefined>): Promise<void> {
    if (this.guard && this.bridgeWorkspace === workspace) return;
    await this.stop();
    const guard = await startGuardServer({
      workspace,
      browserTask: async input => this.runAutomaticTask(input.task, input.taskName, apiKey),
    });
    this.guard = guard;
    this.workspace = workspace;
    this.bridgeWorkspace = workspace;
    this.writeBridgeRegistration();
  }

  async start(workspace: string, endpoint = 'http://127.0.0.1:9222', initialUrl = 'about:blank'): Promise<FastBrowserStatus> {
    if (!this.guard || this.bridgeWorkspace !== workspace) await this.activateBridge(workspace, async () => undefined);
    await this.stopBrowserOnly();
    if (!initialUrl.trim() || initialUrl.trim() === 'about:blank') throw new Error('Choose a real initial page URL; about:blank has no agent actions.');
    try {
      const transport = new CountingTransport(await CdpConnection.connect(endpoint));
      const session = await BrowserSession.create(transport, workspace, initialUrl);
      this.transport = transport;
      this.session = session;
      this.workspace = workspace;
      this.endpoint = endpoint;
      this.lastSnapshot = await session.observe();
      return this.status();
    } catch (error) {
      throw error;
    }
  }

  async stop(): Promise<FastBrowserStatus> {
    const guard = this.guard;
    await this.stopBrowserOnly();
    this.guard = undefined;
    const registration = this.bridgeWorkspace ? browserBridgeConfigPath(this.bridgeWorkspace) : undefined;
    this.workspace = undefined;
    this.endpoint = undefined;
    this.bridgeWorkspace = undefined;
    this.jevRequests = 0;
    this.lastGoalStatus = undefined;
    this.lastSnapshot = undefined;
    try { if (registration) rmSync(registration, { force: true }); } catch { /* best effort */ }
    try { if (guard) { guard.invalidate(); await guard.close(); } } catch { /* best effort */ }
    return this.status();
  }

  status(): FastBrowserStatus {
    return {
      running: Boolean(this.session && this.guard),
      workspace: this.workspace,
      endpoint: this.endpoint,
      targetId: this.session?.targetId,
      protocolCalls: this.transport?.protocolCalls ?? 0,
      screenshots: this.transport?.screenshots ?? 0,
      jevRequests: this.jevRequests,
      lastGoalStatus: this.lastGoalStatus,
      pageUrl: this.lastSnapshot?.url,
      observedActions: this.lastSnapshot?.actions.length,
      completedGoals: this.completedGoals,
      blockedGoals: this.blockedGoals,
      failedGoals: this.failedGoals,
    };
  }

  async observe(): Promise<BrowserSnapshot> {
    if (!this.session) throw new Error('Fast Browser is not running');
    this.lastSnapshot = await this.session.observe();
    return this.lastSnapshot;
  }

  async execute(action: ObservedAction, observed: BrowserSnapshot, confirmed = false) {
    if (!this.session || !this.guard) throw new Error('Fast Browser is not running');
    const endpoint: GuardEndpoint = { endpoint: `http://127.0.0.1:${this.guard.port}`, token: this.guard.token };
    return this.session.execute(action, observed, endpoint, { confirmed });
  }

  async runGoal(goal: string, apiKey: string, ui: { confirm(reason: string, action: ObservedAction, decision: BrowserDecision): Promise<boolean>; resolveFill(action: ObservedAction): Promise<string | undefined> }): Promise<BrowserGoalResult> {
    if (!this.session || !this.guard) throw new Error('Fast Browser is not running');
    const guard: GuardEndpoint = { endpoint: `http://127.0.0.1:${this.guard.port}`, token: this.guard.token };
    const decide = createJevBrowserDecider(apiKey);
    const result = await runBrowserGoal(this.session, goal, guard, {
      decide: async (...args) => { this.jevRequests += 1; return decide(...args); },
      confirm: ui.confirm,
      resolveFill: (action) => ui.resolveFill(action)
    });
    this.lastGoalStatus = result.status;
    this.lastSnapshot = result.snapshot;
    if (result.status === 'done') {
      this.completedGoals += 1;
    } else if (result.status === 'blocked') {
      this.blockedGoals += 1;
    } else {
      this.failedGoals += 1;
    }
    return result;
  }

  /** Execute a real Antigravity browser_subagent task, then remove the browser. */
  private async runAutomaticTask(task: string, taskName: string, apiKeyProvider: () => Promise<string | undefined>): Promise<string> {
    if (!this.guard || !this.workspace) return 'Jev Guard: workspace browser control endpoint is unavailable.';
    if (this.taskBusy) return 'Jev Guard: another browser task is already running for this workspace.';
    const apiKey = await apiKeyProvider();
    if (!apiKey) return 'Jev Guard: no Typesafe API key is configured; browser task was not started.';
    this.taskBusy = true;
    try {
      const url = normalizeTaskUrl(extractTaskUrl(task) ?? 'https://example.com');
      await this.startVisibleBrowser(this.workspace, url);
      const result = await this.runGoal(task, apiKey, {
        // The original prompt is task-level consent. It may satisfy a low-risk
        // ask for an ordinary click, scroll, or wait, but it never authorizes
        // data entry, submission, or a danger signal such as secrets/exfiltration.
        confirm: async (_reason, action, decision) => isPromptAuthorizedAsk(action, decision),
        resolveFill: async () => undefined,
      });
      return `Jev Fast Browser ${result.status}: ${result.reason ?? `${taskName} completed`} (steps=${result.steps}; actions=${result.history.join(',') || 'none'}).`;
    } catch (error) {
      return `Jev Fast Browser failed safely: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.taskBusy = false;
    }
  }

  private async startVisibleBrowser(workspace: string, initialUrl: string): Promise<void> {
    await this.stopBrowserOnly();
    const executable = chromeExecutable();
    if (!executable) throw new Error('Chrome was not found. Install Chrome or configure a supported Chrome installation.');
    const port = await freeLoopbackPort();
    const profile = mkdtempSync(join(tmpdir(), 'jev-guard-chrome-'));
    const process = spawn(executable, [
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', initialUrl,
    ], { windowsHide: false });
    this.browserProcess = process;
    this.browserProfile = profile;
    this.endpoint = `http://127.0.0.1:${port}`;
    try {
      const transport = new CountingTransport(await connectWithRetry(this.endpoint));
      this.transport = transport;
      this.session = await BrowserSession.create(transport, workspace, initialUrl);
      this.lastSnapshot = await this.session.observe();
    } catch (error) {
      await this.stopBrowserOnly();
      throw error;
    }
  }

  private async stopBrowserOnly(): Promise<void> {
    const session = this.session;
    const process = this.browserProcess;
    const profile = this.browserProfile;
    this.session = undefined;
    this.transport = undefined;
    this.browserProcess = undefined;
    this.browserProfile = undefined;
    this.endpoint = undefined;
    this.lastSnapshot = undefined;
    try { if (session) await session.close(); } catch { /* Chrome may already have exited */ }
    try { if (process && !process.killed) process.kill(); } catch { /* best effort */ }
    try { if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Chrome can release it shortly after close */ }
  }

  private writeBridgeRegistration(): void {
    if (!this.guard || !this.bridgeWorkspace) return;
    const path = browserBridgeConfigPath(this.bridgeWorkspace);
    const temp = `${path}.${process.pid}.tmp`;
    const value = JSON.stringify({ endpoint: `http://127.0.0.1:${this.guard.port}`, token: this.guard.token, workspace: this.bridgeWorkspace });
    mkdirSync(join(this.bridgeWorkspace, '.jev'), { recursive: true });
    writeFileSync(temp, value, 'utf8');
    renameSync(temp, path);
  }
}

function isPromptAuthorizedAsk(action: ObservedAction, decision: BrowserDecision): boolean {
  if (!['click', 'scroll', 'wait'].includes(action.kind)) return false;
  const signals = decision.signals;
  return (
    signals.destructive < 0.5 &&
    signals.secrets < 0.5 &&
    signals.exfiltration < 0.5 &&
    signals.outsideWorkspace < 0.5 &&
    signals.risk < 2.5
  );
}

function extractTaskUrl(task: string): string | undefined {
  const match = task.match(/https?:\/\/[^\s)'"\]}>,]+/i);
  return match?.[0];
}

function normalizeTaskUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
    return url.href;
  } catch {
    throw new Error(`The browser task did not contain a valid absolute http(s) URL: ${JSON.stringify(value)}`);
  }
}

function chromeExecutable(): string | undefined {
  const candidates = [
    process.env['PROGRAMFILES'] && join(process.env['PROGRAMFILES'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['LOCALAPPDATA'] && join(process.env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter((value): value is string => Boolean(value));
  return candidates.find(existsSync);
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!port) throw new Error('Could not reserve a local Chrome debugging port.');
  return port;
}

async function connectWithRetry(endpoint: string): Promise<CdpConnection> {
  let last: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { return await CdpConnection.connect(endpoint); } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  throw last instanceof Error ? last : new Error('Chrome debugging endpoint did not start.');
}
