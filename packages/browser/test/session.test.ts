import { describe, expect, it, vi } from 'vitest';
import { BrowserSession, SNAPSHOT_SCRIPT, StalePageError, type BrowserSnapshot, type CdpTransport } from '../src/index.js';

const observed: BrowserSnapshot = {
  url: 'https://example.com/settings',
  title: 'Settings',
  visibleText: 'Delete account',
  fingerprint: 'page-v1',
  actions: [{ id: 'e1', node: 1, kind: 'click', label: 'Delete account', role: 'button' }]
};

class FakeCdp implements CdpTransport {
  readonly calls: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }> = [];
  snapshots: BrowserSnapshot[] = [observed];

  async call<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> {
    this.calls.push({ method, params, sessionId });
    if (method === 'Runtime.evaluate' && params?.expression === SNAPSHOT_SCRIPT) {
      return { result: { value: this.snapshots.shift() ?? observed } } as T;
    }
    if (method === 'Runtime.evaluate') return { result: { value: { x: 20, y: 30 } } } as T;
    return {} as T;
  }

  close(): void {}
}

describe('guarded browser session', () => {
  it('explicitly navigates and waits for the requested page before returning', async () => {
    const calls: string[] = [];
    const cdp: CdpTransport = {
      async call<T = unknown>(method: string): Promise<T> {
        calls.push(method);
        if (method === 'Target.createTarget') return { targetId: 'target' } as T;
        if (method === 'Target.attachToTarget') return { sessionId: 'session' } as T;
        if (method === 'Runtime.evaluate') return { result: { value: { ready: 'complete', url: 'https://example.com/' } } } as T;
        return {} as T;
      },
      close() {}
    };
    const session = await BrowserSession.create(cdp, 'C:\\demo', 'https://example.com');
    expect(session.targetId).toBe('target');
    expect(calls).toEqual(['Target.createTarget', 'Target.attachToTarget', 'Page.enable', 'Emulation.setFocusEmulationEnabled', 'Runtime.evaluate']);
  });

  it('does not send a mutation to CDP when the guard denies it', async () => {
    const cdp = new FakeCdp();
    const guardFetch = vi.fn(async () => new Response(JSON.stringify({ decision: 'deny', reason: 'destructive', latencyMs: 3 }), { status: 200 }));
    const session = new BrowserSession(cdp, 'target', 'session', 'C:\\demo');

    const result = await session.execute(observed.actions[0]!, observed, { endpoint: 'http://127.0.0.1:4312', token: 'secret' }, { fetcher: guardFetch as typeof fetch });

    expect(result).toMatchObject({ executed: false, decision: { decision: 'deny' } });
    expect(cdp.calls).toHaveLength(1);
    expect(cdp.calls[0]?.method).toBe('Runtime.evaluate');
  });

  it('executes an allowed action only after a second freshness check', async () => {
    const cdp = new FakeCdp();
    cdp.snapshots = [observed, observed];
    const guardFetch = vi.fn(async () => new Response(JSON.stringify({ decision: 'allow', latencyMs: 2 }), { status: 200 }));
    const session = new BrowserSession(cdp, 'target', 'session', 'C:\\demo');

    const result = await session.execute(observed.actions[0]!, observed, { endpoint: 'http://127.0.0.1:4312', token: 'secret' }, { fetcher: guardFetch as typeof fetch });

    expect(result.executed).toBe(true);
    expect(cdp.calls.map(call => call.method)).toEqual([
      'Runtime.evaluate',
      'Runtime.evaluate',
      'Runtime.evaluate',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent'
    ]);
  });

  it('rejects stale pages before contacting the guard or mutating CDP', async () => {
    const cdp = new FakeCdp();
    cdp.snapshots = [{ ...observed, fingerprint: 'page-v2' }];
    const guardFetch = vi.fn();
    const session = new BrowserSession(cdp, 'target', 'session', 'C:\\demo');

    await expect(session.execute(observed.actions[0]!, observed, { endpoint: 'http://127.0.0.1:4312', token: 'secret' }, { fetcher: guardFetch as typeof fetch })).rejects.toBeInstanceOf(StalePageError);
    expect(guardFetch).not.toHaveBeenCalled();
    expect(cdp.calls).toHaveLength(1);
  });
});
