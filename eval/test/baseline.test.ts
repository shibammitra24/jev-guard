import { describe, expect, it } from 'vitest';
import { baselinePrompt, heuristicBaseline, renderComparison, runBaseline } from '../baseline.js';
import { cases } from '../cases/index.js';

describe('baseline comparison', () => {
  it('builds the shared rubric prompt and classifies obvious threats', () => { expect(baselinePrompt(cases[0])).toContain('Classify this coding-agent action'); expect(heuristicBaseline(cases.find(c => c.id === 'dangerous-1')!)).toBe('deny'); });
  it('renders measured comparison metrics', async () => { const results = await runBaseline(); const report = renderComparison(results); expect(results).toHaveLength(60); expect(report).toContain('Offline baseline proxy'); });
});
