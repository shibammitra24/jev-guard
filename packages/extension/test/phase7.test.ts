import { describe, expect, it } from 'vitest';
import { evaluateCommandPrompt } from '../src/workflow.js';
import { BrowserSession, type CdpTransport } from 'jev-fast-browser';
import { startGuardServer } from 'jev-guard-cli/server';
import { runBrowserBridge } from 'jev-guard-cli/adapters/browser-bridge';

class MockCdp implements CdpTransport {
  public calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  public connected = true;

  async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.connected) throw new Error('CDP connection closed');
    this.calls.push({ method, params });
    if (method === 'Target.createTarget') {
      return { targetId: 'target-1' } as T;
    }
    if (method === 'Target.attachToTarget') {
      return { sessionId: 'session-1' } as T;
    }
    if (method === 'Runtime.evaluate') {
      const expr = String(params?.['expression'] ?? '');
      if (expr.includes('readyState')) {
        return {
          result: {
            value: { ready: 'complete', url: 'http://127.0.0.1:4173' },
          },
        } as T;
      }
      return {
        result: {
          value: {
            url: 'http://127.0.0.1:4173',
            title: 'Demo',
            visibleText: 'Demo page',
            actions: [
              { id: 'e1', node: 1, kind: 'click', label: 'More information', role: 'button' },
              { id: 'e2', node: 2, kind: 'click', label: 'Delete demo project', role: 'button' },
            ],
            fingerprint: 'fp-1',
          },
        },
      } as T;
    }
    return {} as T;
  }

  close(): void {
    this.connected = false;
  }
}

describe('Phase 7 — End-to-End Integration Suite', () => {
  const wsA = 'C:\\workspace\\project-a';
  const wsB = 'C:\\workspace\\project-b';

  it('safe command is evaluated through the normal guard → allow', async () => {
    const result = await evaluateCommandPrompt('git status', wsA);
    expect(result.route).toBe('command');
    expect(result.decision).toBe('allow');
  });

  it('dangerous command returns deny/ask and is not executed', async () => {
    const result = await evaluateCommandPrompt('rm -rf src', wsA);
    expect(result.route).toBe('command');
    expect(result.decision).toBe('deny');
  });

  it('safe browser click reaches CDP only after Jev allow', async () => {
    const cdp = new MockCdp();
    const server = await startGuardServer({
      workspace: wsA,
      deps: {
        config: {
          enabled: false, // disabled config allows by default
          debug: false,
          timeoutMs: 1000,
          logPath: '',
          prefilterTools: [],
          thresholds: { denyNoul: 0.85, askNoul: 0.5, denyRisk: 2.5, askRisk: 1.5 },
        },
      },
    });

    const session = await BrowserSession.create(cdp, wsA, 'http://127.0.0.1:4173');
    const snapshot = await session.observe();
    const safeAction = snapshot.actions.find(a => a.id === 'e1')!;

    const result = await session.execute(
      safeAction,
      snapshot,
      { endpoint: `http://127.0.0.1:${server.port}`, token: server.token },
    );

    expect(result.executed).toBe(true);
    expect(result.decision.decision).toBe('allow');
    // CDP mutation calls were made
    const mouseClicks = cdp.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    expect(mouseClicks.length).toBeGreaterThan(0);

    await session.close();
    await server.close();
  });

  it('destructive browser click is blocked before CDP mutation', async () => {
    const cdp = new MockCdp();
    // Guard server configured to deny destructive requests via Jev signal evaluation
    const server = await startGuardServer({
      workspace: wsA,
      deps: {
        config: {
          enabled: true,
          debug: false,
          timeoutMs: 1000,
          logPath: '',
          prefilterTools: [],
          thresholds: { denyNoul: 0.85, askNoul: 0.5, denyRisk: 2.5, askRisk: 1.5 },
        },
        apiKey: 'test-key',
        ask: async () => ({
          answers: {
            destructive: { type: 'noul', noul: 1.0 },
            secrets: { type: 'noul', noul: 0.0 },
            exfiltration: { type: 'noul', noul: 0.0 },
            outsideWorkspace: { type: 'noul', noul: 0.0 },
            risk: { type: 'score', score: 3.0, confidence: 1.0, legend: {}, probabilities: {} },
          },
        }),
      },
    });

    const session = await BrowserSession.create(cdp, wsA, 'http://127.0.0.1:4173');
    const snapshot = await session.observe();
    const dangerAction = snapshot.actions.find(a => a.id === 'e2')!;

    cdp.calls = []; // clear observation calls

    const result = await session.execute(
      dangerAction,
      snapshot,
      { endpoint: `http://127.0.0.1:${server.port}`, token: server.token },
    );

    expect(result.executed).toBe(false);
    expect(result.decision.decision).toBe('deny');
    // Zero CDP mutation calls
    const mutations = cdp.calls.filter(c => c.method.startsWith('Input.'));
    expect(mutations).toHaveLength(0);

    await session.close();
    await server.close();
  });

  it('browser result is returned through host integration path', async () => {
    const hostResult = await runBrowserBridge(
      {
        agent: 'agy',
        tool: 'browser_subagent',
        args: {
          Task: 'Delete project',
          TaskName: 'Delete',
        },
        workspace: wsA,
        raw: {},
      },
      {
        endpoint: `http://127.0.0.1:4312`,
        token: 'test-token',
        workspace: wsA,
      },
      {
        fetcher: async () => ({
          ok: true,
          json: async () => ({ result: 'Successfully performed task' }),
        } as unknown as Response),
      },
    );

    expect(hostResult.verdict).toBe('deny');
    expect(hostResult.reason).toContain('[browser-sidecar] Successfully performed task');
  });

  it('workspace A cannot use workspace B browser session or token', async () => {
    const serverA = await startGuardServer({ workspace: wsA });
    const serverB = await startGuardServer({ workspace: wsB });

    // Try sending workspace B request to server A -> 403
    const resMismatch = await fetch(`http://127.0.0.1:${serverA.port}/v1/decide`, {
      method: 'POST',
      headers: { authorization: `Bearer ${serverA.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace: wsB,
        provenance: 'browser-sidecar',
        page: { url: 'https://example.com', title: 'Example', visibleText: 'text' },
        action: { id: 'a1', kind: 'click', label: 'test', pageFingerprint: 'fp', workspace: wsB },
      }),
    });
    expect(resMismatch.status).toBe(403);

    // Try using server B's token against server A -> 401
    const resAuth = await fetch(`http://127.0.0.1:${serverA.port}/v1/decide`, {
      method: 'POST',
      headers: { authorization: `Bearer ${serverB.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace: wsA,
        provenance: 'browser-sidecar',
        page: { url: 'https://example.com', title: 'Example', visibleText: 'text' },
        action: { id: 'a1', kind: 'click', label: 'test', pageFingerprint: 'fp', workspace: wsA },
      }),
    });
    expect(resAuth.status).toBe(401);

    await serverA.close();
    await serverB.close();
  });

  it('Chrome disconnect fails closed', async () => {
    const cdp = new MockCdp();
    const server = await startGuardServer({
      workspace: wsA,
      deps: {
        config: {
          enabled: false,
          debug: false,
          timeoutMs: 1000,
          logPath: '',
          prefilterTools: [],
          thresholds: { denyNoul: 0.85, askNoul: 0.5, denyRisk: 2.5, askRisk: 1.5 },
        },
      },
    });

    const session = await BrowserSession.create(cdp, wsA, 'http://127.0.0.1:4173');
    const snapshot = await session.observe();
    const safeAction = snapshot.actions.find(a => a.id === 'e1')!;

    // Disconnect Chrome before execution
    cdp.connected = false;

    await expect(
      session.execute(safeAction, snapshot, { endpoint: `http://127.0.0.1:${server.port}`, token: server.token }),
    ).rejects.toThrow();

    await session.close().catch(() => {});
    await server.close();
  });
});
