import { JevError, type JevAnswer, type JevAnswers, type JevQuestion, type NormalizedJevAnswer } from './types';

export interface AskOptions {
  apiKey: string;
  timeoutMs: number;
  signal?: AbortSignal;
  endpoint?: string;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function validateAnswers(value: unknown): JevAnswers {
  if (!value || typeof value !== 'object') throw new JevError('parse', 'Jev response was not an object');
  const body = value as Record<string, unknown>;
  if (!body.answers || typeof body.answers !== 'object') {
    throw new JevError('parse', 'Jev response did not contain answers');
  }
  return body as unknown as JevAnswers;
}

export function normalizeAnswer(answer: JevAnswer): NormalizedJevAnswer {
  if (answer.type === 'noul') {
    return { type: 'noul', value: answer.noul, confidence: answer.noul };
  }
  if (answer.type === 'choice') {
    return {
      type: 'choice',
      value: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
    };
  }
  return {
    type: 'score',
    value: answer.score,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
  };
}

export function normalizeAnswers(answers: JevAnswers): Record<string, NormalizedJevAnswer> {
  return Object.fromEntries(
    Object.entries(answers.answers).map(([key, answer]) => [key, normalizeAnswer(answer)]),
  );
}

export async function ask(
  state: string,
  questions: Record<string, JevQuestion>,
  options: AskOptions,
): Promise<JevAnswers> {
  if (!options.apiKey) throw new JevError('auth', 'Missing Jev API key');
  const timeoutMs = options.timeoutMs > 0 ? options.timeoutMs : 3000;
  const wait = options.sleep ?? delay;
  const random = options.random ?? Math.random;
  let attempt = 0;
  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetch(options.endpoint ?? DEFAULT_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'jev-latest', state, questions }),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (attempt === 0 && isRetryable(response.status)) {
          attempt += 1;
          await wait(200 + Math.floor(random() * 151));
          continue;
        }
        if (response.status === 401 || response.status === 403) {
          throw new JevError('auth', `Jev authentication failed (${response.status})`, response.status);
        }
        throw new JevError('http', `Jev request failed (${response.status})`, response.status);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new JevError('parse', 'Jev response was not valid JSON');
      }
      return validateAnswers(body);
    } catch (error) {
      if (error instanceof JevError) throw error;
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new JevError('timeout', `Jev request timed out after ${timeoutMs}ms`);
      }
      throw new JevError('network', error instanceof Error ? error.message : 'Jev request failed');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}

export { DEFAULT_ENDPOINT };
