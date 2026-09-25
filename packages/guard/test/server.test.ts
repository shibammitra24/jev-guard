import { describe, expect, it } from 'vitest';
import { startGuardServer } from '../src/server.js';

describe('guard server', () => {
  it('accepts only authenticated requests for the selected workspace', async () => {
    const logged: unknown[] = [];
    const workspace = 'C:\\demo'; const server = await startGuardServer({ workspace, deps: { config: { enabled: false, debug: false, timeoutMs: 1000, logPath: '', prefilterTools: [], thresholds: { denyNoul: .85, askNoul: .5, denyRisk: 2.5, askRisk: 1.5 } }, logger: { append: record => logged.push(record), tail: () => [], watch: () => () => undefined } } });
    const body = JSON.stringify({ workspace, provenance: 'browser-sidecar', page: { url: 'https://example.com', title: 'Example', visibleText: '' }, action: { id: 'e1', kind: 'click', label: 'Read', pageFingerprint: 'x', workspace } });
    const unauth = await fetch(`http://127.0.0.1:${server.port}/v1/decide`, { method: 'POST', body }); expect(unauth.status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${server.port}/v1/decide`, { method: 'POST', headers: { authorization: `Bearer ${server.token}` }, body }); expect(ok.status).toBe(200); const result = await ok.json() as { decision: string }; expect(result.decision).toBe('allow');
    expect(logged).toEqual([expect.objectContaining({ agent: 'browser', actionId: 'e1', urlOrigin: 'https://example.com' })]);
    await server.close();
  });

  it('runs a browser task only with the matching loopback token and workspace', async () => {
    const workspace = 'C:\\demo';
    const calls: string[] = [];
    const server = await startGuardServer({
      workspace,
      browserTask: async input => { calls.push(`${input.workspace}:${input.task}`); return 'completed safely'; },
    });
    const body = JSON.stringify({ workspace, task: 'Open https://example.com', taskName: 'Read page' });
    const unauth = await fetch(`http://127.0.0.1:${server.port}/v1/browser/task`, { method: 'POST', body });
    expect(unauth.status).toBe(401);
    const mismatch = await fetch(`http://127.0.0.1:${server.port}/v1/browser/task`, {
      method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: 'C:\\other', task: 'Open https://example.com' }),
    });
    expect(mismatch.status).toBe(403);
    const ok = await fetch(`http://127.0.0.1:${server.port}/v1/browser/task`, {
      method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, body,
    });
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toEqual({ result: 'completed safely' });
    expect(calls).toEqual([`${workspace}:Open https://example.com`]);
    await server.close();
  });
});
