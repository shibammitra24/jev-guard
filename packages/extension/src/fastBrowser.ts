import { BrowserSession, CdpConnection, createJevBrowserDecider, runBrowserGoal, type BrowserGoalResult, type BrowserSnapshot, type CdpTransport, type GuardEndpoint, type ObservedAction } from 'jev-fast-browser';
import { startGuardServer, type GuardServer } from 'jev-guard-cli/server';

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

  async start(workspace: string, endpoint = 'http://127.0.0.1:9222', initialUrl = 'about:blank'): Promise<FastBrowserStatus> {
    await this.stop();
    if (!initialUrl.trim() || initialUrl.trim() === 'about:blank') throw new Error('Choose a real initial page URL; about:blank has no agent actions.');
    const guard = await startGuardServer({ workspace });
    try {
      const transport = new CountingTransport(await CdpConnection.connect(endpoint));
      const session = await BrowserSession.create(transport, workspace, initialUrl);
      this.guard = guard;
      this.transport = transport;
      this.session = session;
      this.workspace = workspace;
      this.endpoint = endpoint;
      this.lastSnapshot = await session.observe();
      return this.status();
    } catch (error) {
      await guard.close();
      throw error;
    }
  }

  async stop(): Promise<FastBrowserStatus> {
    const session = this.session;
    const guard = this.guard;
    this.session = undefined;
    this.guard = undefined;
    this.transport = undefined;
    this.workspace = undefined;
    this.endpoint = undefined;
    this.jevRequests = 0;
    this.lastGoalStatus = undefined;
    this.lastSnapshot = undefined;
    try { if (session) await session.close(); } finally { if (guard) await guard.close(); }
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

  async runGoal(goal: string, apiKey: string, ui: { confirm(reason: string, action: ObservedAction): Promise<boolean>; resolveFill(action: ObservedAction): Promise<string | undefined> }): Promise<BrowserGoalResult> {
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
}
