import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';

const RUNS = 5;
const TASKS = [
  { name: 'docs-navigation', steps: 3, dangerous: false },
  { name: 'settings-workflow', steps: 5, dangerous: false },
  { name: 'blocked-delete', steps: 2, dangerous: true }
];
const chromePath = process.env.JEV_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class Cdp {
  constructor(socket) { this.socket = socket; this.nextId = 1; this.pending = new Map(); socket.on('message', data => this.receive(data)); }
  call(method, params = {}, sessionId) { const id = this.nextId++; return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP command timed out: ${method}`)); }, 10000); this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } }); this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }); }
  receive(data) { const message = JSON.parse(data.toString()); if (!message.id) return; const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result); }
  close() { this.socket.close(); }
}

function pageHtml() {
  return `<!doctype html><html><head><title>Jev live benchmark</title><style>body{font:16px sans-serif;padding:30px}button{padding:12px;margin:6px}</style></head><body><h1>Local benchmark</h1><main id="app"></main><script>window.step=0;window.deleted=false;window.render=()=>{const dangerous=new URLSearchParams(location.search).get('dangerous')==='1';document.getElementById('app').innerHTML='<p>Step '+window.step+'</p><button id="next">Continue</button>'+(dangerous?'<button id="delete">Delete account</button>':'')};document.addEventListener('click',e=>{if(e.target.id==='next'){window.step++;render()}if(e.target.id==='delete')window.deleted=true});render();</script></body></html>`;
}

async function startPageServer() {
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); response.end(pageHtml()); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  return { server, port: typeof address === 'object' && address ? address.port : 0 };
}

async function waitForChrome(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { const response = await fetch(`http://127.0.0.1:${port}/json/version`); if (response.ok) return response.json(); } catch { /* starting */ }
    await sleep(50);
  }
  throw new Error('Chrome debugging endpoint did not start');
}

async function waitReady(cdp, sessionId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await cdp.call('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId);
    if (result.result?.value === 'complete') return;
    await sleep(10);
  }
  throw new Error('Benchmark page did not load');
}

const fastSnapshot = `(() => ({text:document.body.innerText,actions:[...document.querySelectorAll('button,input,a,select')].filter(e=>e.checkVisibility()).map((e,i)=>({id:'e'+(i+1),role:e.tagName,label:e.innerText||e.value}))}))()`;

async function measure(cdp, sessionId, baseUrl, task, mode, run) {
  await cdp.call('Page.navigate', { url: `${baseUrl}/?task=${task.name}&dangerous=${task.dangerous ? 1 : 0}&run=${run}&mode=${mode}` }, sessionId);
  await waitReady(cdp, sessionId);
  let protocolCalls = 0, screenshots = 0, guardRequests = 0, dangerousMutations = 0;
  const call = async (method, params = {}) => { protocolCalls += 1; if (method === 'Page.captureScreenshot') screenshots += 1; return cdp.call(method, params, sessionId); };
  const started = performance.now();
  for (let step = 0; step < task.steps; step += 1) {
    if (mode === 'screenshot-loop') {
      await call('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
      await call('Accessibility.getFullAXTree');
      await call('DOMSnapshot.captureSnapshot', { computedStyles: [] });
    } else await call('Runtime.evaluate', { expression: fastSnapshot, returnByValue: true });
    guardRequests += 1;
    if (task.dangerous && step === task.steps - 1) continue;
    await call('Runtime.evaluate', { expression: "document.getElementById('next').click()" });
  }
  const elapsedMs = performance.now() - started;
  const deleted = await cdp.call('Runtime.evaluate', { expression: 'window.deleted', returnByValue: true }, sessionId);
  if (deleted.result?.value) dangerousMutations += 1;
  return { mode, task: task.name, run, elapsedMs, protocolCalls, screenshots, guardRequests, dangerousMutations };
}

function metric(values, percentile) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percentile))]; }
function summarize(rows, mode) { const selected = rows.filter(row => row.mode === mode); const times = selected.map(row => row.elapsedMs); return { runs: selected.length, meanMs: times.reduce((a, b) => a + b, 0) / times.length, p50Ms: metric(times, .5), p95Ms: metric(times, .95), protocolCalls: selected.reduce((a, row) => a + row.protocolCalls, 0), screenshots: selected.reduce((a, row) => a + row.screenshots, 0), guardRequests: selected.reduce((a, row) => a + row.guardRequests, 0), dangerousMutations: selected.reduce((a, row) => a + row.dangerousMutations, 0) }; }

async function main() {
  const page = await startPageServer();
  const profile = mkdtempSync(join(tmpdir(), 'jev-live-benchmark-'));
  const debugPort = 9400 + Math.floor(Math.random() * 400);
  const chrome = spawn(chromePath, [`--headless=new`, `--remote-debugging-port=${debugPort}`, '--remote-allow-origins=*', `--user-data-dir=${profile}`, '--disable-extensions', '--disable-background-networking', '--no-first-run', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp;
  try {
    const version = await waitForChrome(debugPort);
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    cdp = new Cdp(socket);
    const target = await cdp.call('Target.createTarget', { url: 'about:blank', background: false });
    const attached = await cdp.call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await cdp.call('Page.enable', {}, attached.sessionId);
    await cdp.call('Page.bringToFront', {}, attached.sessionId);
    const baseUrl = `http://127.0.0.1:${page.port}`;
    const rows = [];
    for (let run = 1; run <= RUNS; run += 1) for (const task of TASKS) {
      const order = run % 2 ? ['fast-guard', 'screenshot-loop'] : ['screenshot-loop', 'fast-guard'];
      for (const mode of order) { process.stderr.write(`run ${run}/${RUNS} ${task.name} ${mode}\n`); rows.push(await measure(cdp, attached.sessionId, baseUrl, task, mode, run)); }
    }
    const screenshotLoop = summarize(rows, 'screenshot-loop');
    const fastGuard = summarize(rows, 'fast-guard');
    process.stdout.write(JSON.stringify({ environment: { chrome: version.Browser, platform: process.platform, node: process.version, runsPerTask: RUNS, tasks: TASKS.length }, screenshotLoop, fastGuard, meanWallTimeReduction: 1 - fastGuard.meanMs / screenshotLoop.meanMs, protocolCallReduction: 1 - fastGuard.protocolCalls / screenshotLoop.protocolCalls, rows }, null, 2) + '\n');
  } finally {
    cdp?.close();
    chrome.kill();
    await new Promise(resolve => page.server.close(resolve));
    for (let attempt = 0; attempt < 20; attempt += 1) { try { rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(100); } }
  }
}

await main();
