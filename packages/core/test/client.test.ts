import { afterEach, describe, expect, it, vi } from 'vitest';
import { ask, normalizeAnswers } from '../src/client';

const questions = {
  risk: { type: 'score', instructions: 'risk', criteria: ['safe', 'normal', 'harmful', 'dangerous'] },
} as const;

afterEach(() => vi.restoreAllMocks());

describe('ask', () => {
  it('posts the verified request and returns typed answers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        model: 'jev-1.13.0',
        answers: {
          destructive: { type: 'noul', noul: 0.96 },
          risk: { type: 'score', score: 3, confidence: 1, legend: { '3': 'dangerous' }, probabilities: { '3': 1 } },
        },
      }), { status: 200 }),
    );
    const result = await ask('state', questions, { apiKey: 'test', timeoutMs: 1000 });
    expect(result.answers.destructive).toMatchObject({ type: 'noul', noul: 0.96 });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.typesafe.ai/v1/systemone',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test' }),
      }),
    );
    expect(normalizeAnswers(result).risk).toMatchObject({ value: 3, confidence: 1, type: 'score' });
  });

  it('retries once for 429', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ answers: {} }), { status: 200 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await ask('state', questions, { apiKey: 'test', timeoutMs: 1000, sleep, random: () => 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(200);
  });

  it('classifies auth, malformed JSON, and timeout errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));
    await expect(ask('state', questions, { apiKey: 'test', timeoutMs: 1000 }))
      .rejects.toMatchObject({ kind: 'auth' });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 200 }));
    await expect(ask('state', questions, { apiKey: 'test', timeoutMs: 1000 }))
      .rejects.toMatchObject({ kind: 'parse' });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('aborted', 'AbortError'));
    await expect(ask('state', questions, { apiKey: 'test', timeoutMs: 1 }))
      .rejects.toMatchObject({ kind: 'timeout' });
  });

  it.skipIf(!process.env.JEV_LIVE)('live smoke test (JEV_LIVE=1)', async () => {
    const key = process.env.TYPESAFE_API_KEY;
    if (!key) throw new Error('TYPESAFE_API_KEY is required when JEV_LIVE=1');
    const result = await ask('Agent: antigravity\nTool: list_dir\nArguments:', {
      risk: {
        type: 'score',
        instructions: 'Overall risk of this action to the user.',
        criteria: ['safe', 'normal', 'harmful', 'dangerous'],
      },
    }, { apiKey: key, timeoutMs: 3000 });
    expect(result.answers.risk.type).toBe('score');
  });
});
