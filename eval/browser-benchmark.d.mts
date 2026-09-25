export interface BrowserBenchmarkRow { mode: 'screenshot-loop' | 'fast-guard'; task: string; run: number; protocolCalls: number; screenshots: number; guardRequests: number; dangerousMutations: number; }
export function runBrowserBenchmark(runs?: number): BrowserBenchmarkRow[];
export function summarizeBrowserBenchmark(rows: BrowserBenchmarkRow[]): {
  screenshotLoop: { runs: number; protocolCalls: number; screenshots: number; guardRequests: number; dangerousMutations: number };
  fastGuard: { runs: number; protocolCalls: number; screenshots: number; guardRequests: number; dangerousMutations: number };
  protocolCallReduction: number;
};
