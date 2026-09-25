export interface DecisionRecord {
  ts?: string;
  stage?: string;
  route?: 'command' | 'browser' | string;
  decision?: string;
  verdict?: string;
  agent?: string;
  tool?: string;
  reason?: string;
  latencyMs?: number;
  source?: string;
  url?: string;
  controls?: number;
  operation?: string;
  target?: string;
  actionId?: string;
  actionLabel?: string;
  status?: string;
}

export interface BrowserViewStatus {
  running: boolean;
  workspace?: string;
  endpoint?: string;
  protocolCalls: number;
  screenshots: number;
  jevRequests?: number;
  lastGoalStatus?: string;
  pageUrl?: string;
  observedActions?: number;
  completedGoals?: number;
  blockedGoals?: number;
  failedGoals?: number;
}

export function summarize(records: DecisionRecord[], browserStatus?: BrowserViewStatus) {
  const latencies = records
    .map(r => r.latencyMs)
    .filter((v): v is number => typeof v === 'number' && v > 0)
    .sort((a, b) => a - b);
  const percentile = (v: number) =>
    latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * v))] : 0;
  const verdict = (r: DecisionRecord) => r.decision ?? r.verdict;

  return {
    total: records.length,
    allowed: records.filter(r => verdict(r) === 'allow').length,
    denied: records.filter(r => verdict(r) === 'deny').length,
    asked: records.filter(r => verdict(r) === 'ask' || verdict(r) === 'force_ask').length,
    browser: records.filter(r => r.agent === 'browser' || r.route === 'browser').length,
    jevRequests: browserStatus?.jevRequests ?? records.filter(r => r.source === 'jev' || r.source === 'planner' || r.stage === 'jev_decision').length,
    cdpCalls: browserStatus?.protocolCalls ?? 0,
    screenshots: browserStatus?.screenshots ?? 0,
    completedGoals: browserStatus?.completedGoals ?? records.filter(r => r.status === 'done' || (r.stage === 'workflow_result' && verdict(r) === 'allow' && r.tool === 'browser_goal')).length,
    blockedGoals: browserStatus?.blockedGoals ?? records.filter(r => r.status === 'blocked').length,
    failedGoals: browserStatus?.failedGoals ?? records.filter(r => r.status === 'denied' || r.status === 'failed' || r.stage === 'workflow_error').length,
    p50: percentile(0.5),
    p95: percentile(0.95),
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function timestamp(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

function formatStage(stage?: string, tool?: string): string {
  if (stage) {
    switch (stage) {
      case 'prompt_received': return 'Prompt Received';
      case 'route_selected': return 'Route Selected';
      case 'browser_session': return 'Browser Session';
      case 'jev_decision': return 'Jev Decision';
      case 'page_stale': return 'Page Stale';
      case 'host_error': return 'Host Error';
      case 'workflow_result': return 'Workflow Result';
      default: return stage.replace(/_/g, ' ');
    }
  }
  return tool ?? '—';
}

function formatDetails(record: DecisionRecord): string {
  const parts: string[] = [];
  if (record.actionId || record.actionLabel) {
    parts.push(`[${record.actionId ?? '—'}] ${record.actionLabel ?? ''}`);
  }
  if (record.operation) {
    parts.push(`op: ${record.operation}${record.target ? ` → ${record.target}` : ''}`);
  }
  if (record.url) {
    parts.push(`${record.url} (${record.controls ?? 0} controls)`);
  }
  if (record.reason && record.reason !== record.actionLabel) {
    parts.push(record.reason);
  }
  return parts.join(' · ') || record.tool || '—';
}

function renderRow(record: DecisionRecord): string {
  const decision = record.decision ?? record.verdict ?? 'info';
  const route = record.route ?? (record.agent === 'browser' ? 'browser' : 'command');
  const stageName = formatStage(record.stage, record.tool);
  const details = formatDetails(record);
  const latency = typeof record.latencyMs === 'number' && record.latencyMs > 0 ? `${record.latencyMs}ms` : '—';

  return `
    <tr class="row-${escapeHtml(decision)}">
      <td class="col-ts">${escapeHtml(timestamp(record.ts))}</td>
      <td class="col-route"><span class="badge badge-${escapeHtml(route)}">${escapeHtml(route)}</span></td>
      <td class="col-stage"><span class="badge badge-stage">${escapeHtml(stageName)}</span></td>
      <td class="col-details">${escapeHtml(details)}</td>
      <td class="col-decision"><span class="badge badge-${escapeHtml(decision)}">${escapeHtml(decision.toUpperCase())}</span></td>
      <td class="col-lat">${escapeHtml(latency)}</td>
    </tr>`;
}

function browserDescription(browser: BrowserViewStatus): string {
  if (!browser.running) {
    return 'Browser inactive. A browser prompt can start it automatically.';
  }
  return `${escapeHtml(browser.pageUrl ?? 'loading')} · ${browser.observedActions ?? 0} controls · ${browser.protocolCalls} CDP calls · ${browser.screenshots} screenshots · ${browser.jevRequests ?? 0} planner requests`;
}

export function renderConsoleHtml(
  records: DecisionRecord[],
  browser: BrowserViewStatus = { running: false, protocolCalls: 0, screenshots: 0 },
): string {
  const summary = summarize(records, browser);
  const rows = records.slice(-200).reverse().map(renderRow).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <title>Jev Guard Workflow Console</title>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: rgba(22, 27, 34, 0.85);
      --border: rgba(240, 246, 252, 0.1);
      --text-primary: #e6edf3;
      --text-muted: #8b949e;
      --accent-blue: #58a6ff;
      --accent-purple: #bc8cff;
      --allow: #3fb950;
      --deny: #f85149;
      --ask: #d29922;
      --card-hover: rgba(56, 139, 253, 0.15);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text-primary);
      padding: 16px;
      line-height: 1.5;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }
    .header h2 {
      font-size: 18px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
      background: linear-gradient(135deg, #58a6ff 0%, #bc8cff 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .btn {
      background: var(--vscode-button-background, #238636);
      color: #fff;
      border: 1px solid rgba(240, 246, 252, 0.1);
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease-in-out;
    }
    .btn:hover {
      filter: brightness(1.15);
      transform: translateY(-1px);
    }
    .btn-secondary {
      background: #21262d;
      color: #c9d1d9;
    }
    .btn-secondary:hover {
      background: #30363d;
    }
    .workflow {
      display: grid;
      gap: 8px;
      margin: 14px 0;
      padding: 14px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      backdrop-filter: blur(10px);
    }
    .workflow textarea {
      min-height: 64px;
      resize: vertical;
      background: #090d13;
      color: var(--text-primary);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px;
      font-family: inherit;
      font-size: 13px;
    }
    .browser-panel {
      margin: 12px 0;
      padding: 12px 14px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .browser-info { display: flex; flex-direction: column; gap: 4px; }
    .browser-meta { font-size: 12px; color: var(--text-muted); }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
      gap: 10px;
      margin: 14px 0;
    }
    .card {
      padding: 10px 12px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      gap: 2px;
      transition: border-color 0.2s, transform 0.15s;
    }
    .card:hover {
      border-color: rgba(88, 166, 255, 0.4);
      transform: translateY(-2px);
    }
    .card-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); }
    .card-val { font-size: 18px; font-weight: 700; color: var(--text-primary); }
    .card-val.allow { color: var(--allow); }
    .card-val.deny { color: var(--deny); }
    .card-val.ask { color: var(--ask); }
    .card-val.browser { color: var(--accent-blue); }
    .card-val.highlight { color: var(--accent-purple); }

    .stream-header {
      margin-top: 20px;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .stream-header h3 { font-size: 14px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }

    .table-container {
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--card-bg);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      text-align: left;
    }
    th {
      background: #161b22;
      color: var(--text-muted);
      font-weight: 600;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }
    td {
      padding: 8px 12px;
      border-bottom: 1px solid rgba(240, 246, 252, 0.05);
      vertical-align: middle;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover { background: rgba(255, 255, 255, 0.02); }

    .col-ts { color: var(--text-muted); font-family: monospace; font-size: 11px; white-space: nowrap; }
    .col-details { color: var(--text-primary); word-break: break-word; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .col-lat { color: var(--text-muted); font-family: monospace; font-size: 11px; text-align: right; white-space: nowrap; }

    .badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .badge-browser { background: rgba(88, 166, 255, 0.15); color: #58a6ff; border: 1px solid rgba(88, 166, 255, 0.3); }
    .badge-command { background: rgba(188, 140, 255, 0.15); color: #bc8cff; border: 1px solid rgba(188, 140, 255, 0.3); }
    .badge-stage { background: #21262d; color: #8b949e; border: 1px solid var(--border); text-transform: none; }
    .badge-allow { background: rgba(63, 185, 80, 0.15); color: #3fb950; border: 1px solid rgba(63, 185, 80, 0.3); }
    .badge-deny { background: rgba(248, 81, 73, 0.15); color: #f85149; border: 1px solid rgba(248, 81, 73, 0.3); }
    .badge-ask, .badge-force_ask { background: rgba(210, 153, 34, 0.15); color: #d29922; border: 1px solid rgba(210, 153, 34, 0.3); }
    .badge-info { background: #21262d; color: #8b949e; border: 1px solid var(--border); }
  </style>
</head>
<body>
  <div class="header">
    <h2>⚡ Jev Guard Console</h2>
    <button class="btn btn-secondary" id="clear">Clear logs</button>
  </div>

  <div class="workflow">
    <b>Protected workflow</b>
    <textarea id="prompt" placeholder="Example: Open https://example.com and click More information — or — delete the src folder"></textarea>
    <button class="btn" id="runWorkflow">Run through Jev</button>
  </div>

  <div class="browser-panel">
    <div class="browser-info">
      <div><b>Fast Browser: <span id="browserState">${browser.running ? 'Running' : 'Stopped'}</span></b></div>
      <div class="browser-meta" id="browserMeta">${browserDescription(browser)}</div>
    </div>
    <div class="actions">
      <button class="btn btn-secondary" id="start">Start browser</button>
      <button class="btn btn-secondary" id="run">Browser goal</button>
      <button class="btn btn-secondary" id="stop">Stop</button>
    </div>
  </div>

  <div class="cards-grid">
    <div class="card"><span class="card-label">Total Events</span><span class="card-val" id="total">${summary.total}</span></div>
    <div class="card"><span class="card-label">Jev Requests</span><span class="card-val highlight" id="jevRequests">${summary.jevRequests}</span></div>
    <div class="card"><span class="card-label">Allowed</span><span class="card-val allow" id="allowed">${summary.allowed}</span></div>
    <div class="card"><span class="card-label">Blocked</span><span class="card-val deny" id="denied">${summary.denied}</span></div>
    <div class="card"><span class="card-label">Asked</span><span class="card-val ask" id="asked">${summary.asked}</span></div>
    <div class="card"><span class="card-label">Browser Calls</span><span class="card-val browser" id="browser">${summary.browser}</span></div>
    <div class="card"><span class="card-label">CDP Calls</span><span class="card-val" id="cdpCalls">${summary.cdpCalls}</span></div>
    <div class="card"><span class="card-label">Screenshots</span><span class="card-val" id="screenshots">${summary.screenshots}</span></div>
    <div class="card"><span class="card-label">Goals Done</span><span class="card-val allow" id="completedGoals">${summary.completedGoals}</span></div>
    <div class="card"><span class="card-label">Goals Blocked</span><span class="card-val ask" id="blockedGoals">${summary.blockedGoals}</span></div>
    <div class="card"><span class="card-label">Goals Failed</span><span class="card-val deny" id="failedGoals">${summary.failedGoals}</span></div>
    <div class="card"><span class="card-label">p50 Latency</span><span class="card-val" id="p50">${summary.p50}ms</span></div>
    <div class="card"><span class="card-label">p95 Latency</span><span class="card-val" id="p95">${summary.p95}ms</span></div>
  </div>

  <div class="stream-header">
    <h3>Workflow Stream</h3>
  </div>

  <div class="table-container">
    <table>
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>Route</th>
          <th>Stage</th>
          <th>Action & Context Details</th>
          <th>Decision</th>
          <th style="text-align: right;">Latency</th>
        </tr>
      </thead>
      <tbody id="rows">${rows || '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 24px;">No workflow events yet</td></tr>'}</tbody>
    </table>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const stamp = s => {
      if (!s) return '—';
      const d = new Date(s);
      return isNaN(d.getTime()) ? s : d.toLocaleTimeString();
    };

    function formatStageClient(stage, tool) {
      if (stage) {
        if (stage === 'prompt_received') return 'Prompt Received';
        if (stage === 'route_selected') return 'Route Selected';
        if (stage === 'browser_session') return 'Browser Session';
        if (stage === 'jev_decision') return 'Jev Decision';
        if (stage === 'page_stale') return 'Page Stale';
        if (stage === 'host_error') return 'Host Error';
        if (stage === 'workflow_result') return 'Workflow Result';
        return stage.replace(/_/g, ' ');
      }
      return tool || '—';
    }

    function formatDetailsClient(r) {
      const parts = [];
      if (r.actionId || r.actionLabel) parts.push('[' + (r.actionId || '—') + '] ' + (r.actionLabel || ''));
      if (r.operation) parts.push('op: ' + r.operation + (r.target ? ' → ' + r.target : ''));
      if (r.url) parts.push(r.url + ' (' + (r.controls || 0) + ' controls)');
      if (r.reason && r.reason !== r.actionLabel) parts.push(r.reason);
      return parts.join(' · ') || r.tool || '—';
    }

    document.getElementById('clear').onclick = () => {
      if (confirm('Clear all Jev logs?')) vscode.postMessage({ type: 'clearLogs' });
    };
    document.getElementById('start').onclick = () => vscode.postMessage({ type: 'startBrowser' });
    document.getElementById('run').onclick = () => vscode.postMessage({ type: 'runBrowser' });
    document.getElementById('stop').onclick = () => vscode.postMessage({ type: 'stopBrowser' });
    document.getElementById('runWorkflow').onclick = () => {
      const prompt = document.getElementById('prompt').value.trim();
      if (prompt) vscode.postMessage({ type: 'runWorkflow', prompt });
    };

    window.addEventListener('message', event => {
      const data = event.data;
      const summary = data.summary;
      const b = data.browser;

      const keys = ['total', 'jevRequests', 'allowed', 'denied', 'asked', 'browser', 'cdpCalls', 'screenshots', 'completedGoals', 'blockedGoals', 'failedGoals'];
      for (const k of keys) {
        const el = document.getElementById(k);
        if (el) el.textContent = summary[k] ?? 0;
      }
      document.getElementById('p50').textContent = summary.p50 + 'ms';
      document.getElementById('p95').textContent = summary.p95 + 'ms';

      document.getElementById('browserState').textContent = b.running ? 'Running' : 'Stopped';
      document.getElementById('browserMeta').textContent = b.running
        ? ((b.pageUrl ?? 'loading') + ' · ' + (b.observedActions ?? 0) + ' controls · ' + b.protocolCalls + ' CDP calls · ' + b.screenshots + ' screenshots · ' + (b.jevRequests ?? 0) + ' planner requests')
        : 'Browser inactive. A browser prompt can start it automatically.';

      const rowsHtml = data.records.map(r => {
        const d = r.decision ?? r.verdict ?? 'info';
        const route = r.route ?? (r.agent === 'browser' ? 'browser' : 'command');
        const stageName = formatStageClient(r.stage, r.tool);
        const details = formatDetailsClient(r);
        const lat = typeof r.latencyMs === 'number' && r.latencyMs > 0 ? r.latencyMs + 'ms' : '—';
        return '<tr class="row-' + esc(d) + '">' +
          '<td class="col-ts">' + esc(stamp(r.ts)) + '</td>' +
          '<td class="col-route"><span class="badge badge-' + esc(route) + '">' + esc(route) + '</span></td>' +
          '<td class="col-stage"><span class="badge badge-stage">' + esc(stageName) + '</span></td>' +
          '<td class="col-details">' + esc(details) + '</td>' +
          '<td class="col-decision"><span class="badge badge-' + esc(d) + '">' + esc(d.toUpperCase()) + '</span></td>' +
          '<td class="col-lat">' + esc(lat) + '</td>' +
          '</tr>';
      }).join('');

      document.getElementById('rows').innerHTML = rowsHtml || '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 24px;">No workflow events yet</td></tr>';
    });
  </script>
</body>
</html>`;
}
