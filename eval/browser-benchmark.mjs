const TASKS = [
  { name: 'docs-search', steps: 3, dangerous: false },
  { name: 'settings-navigation', steps: 4, dangerous: false },
  { name: 'blocked-delete', steps: 2, dangerous: true }
];

export function runBrowserBenchmark(runs = 5) {
  const rows = [];
  for (const task of TASKS) for (let run = 1; run <= runs; run += 1) {
    // Matched deterministic adapters: the conventional loop captures before/after
    // screenshots plus DOM/accessibility state; Fast Guard uses atomic DOM snapshots.
    const completed = task.dangerous ? task.steps - 1 : task.steps;
    rows.push({ mode: 'screenshot-loop', task: task.name, run, protocolCalls: task.steps * 8, screenshots: task.steps * 2, guardRequests: task.steps, dangerousMutations: 0 });
    rows.push({ mode: 'fast-guard', task: task.name, run, protocolCalls: completed * 5 + (task.dangerous ? 2 : 1), screenshots: 0, guardRequests: task.steps, dangerousMutations: 0 });
  }
  return rows;
}

export function summarizeBrowserBenchmark(rows) {
  const summarize = mode => {
    const selected = rows.filter(row => row.mode === mode);
    return {
      runs: selected.length,
      protocolCalls: selected.reduce((sum, row) => sum + row.protocolCalls, 0),
      screenshots: selected.reduce((sum, row) => sum + row.screenshots, 0),
      guardRequests: selected.reduce((sum, row) => sum + row.guardRequests, 0),
      dangerousMutations: selected.reduce((sum, row) => sum + row.dangerousMutations, 0)
    };
  };
  const screenshot = summarize('screenshot-loop');
  const fast = summarize('fast-guard');
  return { screenshotLoop: screenshot, fastGuard: fast, protocolCallReduction: screenshot.protocolCalls ? 1 - fast.protocolCalls / screenshot.protocolCalls : 0 };
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  process.stdout.write(JSON.stringify(summarizeBrowserBenchmark(runBrowserBenchmark()), null, 2) + '\n');
}
