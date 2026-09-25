import { describe, expect, it } from 'vitest';
import { runBrowserBenchmark, summarizeBrowserBenchmark } from '../browser-benchmark.mjs';

describe('matched browser benchmark', () => {
  it('runs every task five times in both modes and blocks dangerous mutations', () => {
    const rows = runBrowserBenchmark();
    const summary = summarizeBrowserBenchmark(rows);
    expect(rows).toHaveLength(30);
    expect(summary.screenshotLoop.runs).toBe(15);
    expect(summary.fastGuard.runs).toBe(15);
    expect(summary.fastGuard.screenshots).toBe(0);
    expect(summary.fastGuard.protocolCalls).toBeLessThan(summary.screenshotLoop.protocolCalls);
    expect(summary.fastGuard.dangerousMutations).toBe(0);
  });
});
