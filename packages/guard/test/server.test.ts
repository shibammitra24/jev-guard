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
});
