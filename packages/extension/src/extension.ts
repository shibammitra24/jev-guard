import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { renderConsoleHtml, summarize, type DecisionRecord } from './console.js';
import { FastBrowserController } from './fastBrowser.js';
import { installGuard, uninstallGuard } from './installer.js';
import { collectContext } from './router/context.js';
import { createExecutors } from './router/executors.js';
import { createRegistry } from './router/registry.js';
import { routeCommand } from './router/router.js';
import { setApiKey } from './secrets.js';
import { testGuard } from './testGuard.js';
import { classifyWorkflowPrompt, evaluateCommandPrompt, extractPromptUrl } from './workflow.js';

type Disposable = { dispose(): void };
type WebviewMessage = { type?: string; prompt?: string };
type Webview = { html: string; options?: { enableScripts?: boolean }; postMessage(message: unknown): Promise<boolean>; onDidReceiveMessage(listener: (message: WebviewMessage) => void): Disposable };
export interface ExtensionContextLike { subscriptions?: { push(value: unknown): void }; secrets?: { store(key: string, value: string): Promise<void>; get?(key: string): Promise<string | undefined> }; asAbsolutePath?: (path: string) => string; }

const fastBrowser = new FastBrowserController();
const decisionLogPath = join(homedir(), '.jev', 'decisions.jsonl');

function appendConsoleRecord(record: Record<string, unknown>): void {
  try {
    mkdirSync(join(homedir(), '.jev'), { recursive: true });
    appendFileSync(decisionLogPath, JSON.stringify({ ts: new Date().toISOString(), agent: 'browser', latencyMs: 0, ...record }) + '\n', 'utf8');
  } catch { /* console logging is best effort */ }
}

export function activate(context?: ExtensionContextLike): void {
  if (!context?.subscriptions) return;
  let vscode: {
    commands?: { registerCommand(id: string, fn: (...args: unknown[]) => unknown): unknown; executeCommand?(id: string, ...args: unknown[]): Promise<unknown> };
    window?: {
      showInputBox?: (opts: { prompt: string; password?: boolean; value?: string }) => Promise<string | undefined>;
      showInformationMessage?: (message: string) => unknown;
      showErrorMessage?: (message: string) => unknown;
      showWarningMessage?: (message: string, options: { modal: boolean }, item: string) => Promise<string | undefined>;
      registerWebviewViewProvider?: (id: string, provider: unknown) => unknown;
    };
    workspace?: { workspaceFolders?: Array<{ uri: { fsPath: string } }> };
  };
  try { vscode = require('vscode') as typeof vscode; } catch { return; }

  const register = (id: string, fn: (...args: unknown[]) => unknown) => {
    const disposable = vscode.commands?.registerCommand?.(id, fn);
    if (disposable) context.subscriptions?.push(disposable);
  };
  const chooseWorkspace = () => vscode.window?.showInputBox?.({ prompt: 'Absolute folder where Jev Guard should be active', value: vscode.workspace?.workspaceFolders?.[0]?.uri.fsPath ?? '' });

  const startBrowser = async (workspaceDir?: string, suggestedUrl?: string) => {
    const workspace = workspaceDir ?? await chooseWorkspace();
    if (!workspace) return;
    const endpoint = await vscode.window?.showInputBox?.({ prompt: 'Chrome/Edge remote debugging endpoint', value: 'http://127.0.0.1:9222' });
    if (!endpoint) return;
    const initialUrl = suggestedUrl ?? await vscode.window?.showInputBox?.({ prompt: 'Initial page URL', value: 'https://example.com' });
    if (!initialUrl) return;
    try {
      const status = await fastBrowser.start(workspace, endpoint, initialUrl);
      appendConsoleRecord({
        agent: 'browser',
        route: 'browser',
        stage: 'browser_session',
        tool: 'browser_start',
        url: status.pageUrl,
        controls: status.observedActions,
        decision: 'allow',
        reason: `Connected to ${status.pageUrl}; observed ${status.observedActions ?? 0} controls.`,
        source: 'pipeline',
      });
      vscode.window?.showInformationMessage?.(`Jev Fast Browser started: ${status.pageUrl} (${status.observedActions ?? 0} controls)`);
      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendConsoleRecord({
        agent: 'browser',
        route: 'browser',
        stage: 'host_error',
        tool: 'browser_start',
        decision: 'deny',
        reason: message,
        source: 'pipeline',
      });
      vscode.window?.showErrorMessage?.(`Could not start Jev Fast Browser: ${message}. Start visible Chrome with --remote-debugging-port=9222 and retry.`);
      return undefined;
    }
  };

  const runBrowserGoal = async (goal: string) => {
    const apiKey = await context.secrets?.get?.('typesafeApiKey');
    if (!apiKey) { vscode.window?.showErrorMessage?.('Set the Typesafe API key with Jev: Set API Key first.'); return; }
    const started = Date.now();
    try {
      const result = await fastBrowser.runGoal(goal, apiKey, {
        confirm: async (reason, action) => (await vscode.window?.showWarningMessage?.(`${reason}\n\nAction: ${action.kind} ${action.label}`, { modal: true }, 'Allow once')) === 'Allow once',
        resolveFill: action => vscode.window?.showInputBox?.({ prompt: `Text to enter in ${action.label}` }) ?? Promise.resolve(undefined)
      });
      appendConsoleRecord({
        agent: 'browser',
        route: 'browser',
        stage: 'workflow_result',
        tool: 'browser_goal',
        status: result.status,
        decision: result.status === 'done' ? 'allow' : 'deny',
        reason: `${result.status}: ${result.reason ?? 'goal completed'}; steps=${result.steps}; actions=${result.history.join(',')}`,
        source: 'planner',
        latencyMs: Date.now() - started
      });
      vscode.window?.showInformationMessage?.(`Fast Browser finished: ${result.status} (${result.steps} steps)${result.reason ? ` — ${result.reason}` : ''}`);
      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const isStale = /stale|fingerprint/i.test(reason);
      appendConsoleRecord({
        agent: 'browser',
        route: 'browser',
        stage: isStale ? 'page_stale' : 'host_error',
        tool: 'browser_goal',
        decision: 'deny',
        reason,
        source: 'planner',
        latencyMs: Date.now() - started
      });
      vscode.window?.showErrorMessage?.(`Fast Browser failed: ${reason}`);
      return undefined;
    }
  };

  const runWorkflow = async (suppliedPrompt?: unknown) => {
    const prompt = typeof suppliedPrompt === 'string' && suppliedPrompt.trim() ? suppliedPrompt.trim() : await vscode.window?.showInputBox?.({ prompt: 'Give Jev a command or browser task' });
    if (!prompt) return;
    const workspaceDir = fastBrowser.status().workspace ?? await chooseWorkspace();
    if (!workspaceDir) return;
    const route = classifyWorkflowPrompt(prompt);
    appendConsoleRecord({
      stage: 'prompt_received',
      route,
      decision: 'allow',
      reason: prompt,
      source: 'user',
    });
    appendConsoleRecord({
      stage: 'route_selected',
      tool: 'workflow_route',
      route,
      decision: 'allow',
      reason: `Prompt routed to ${route}: ${prompt}`,
      source: 'pipeline'
    });
    try {
      if (route === 'command') {
        const started = Date.now();
        const result = await evaluateCommandPrompt(prompt, workspaceDir);
        appendConsoleRecord({
          agent: 'agy',
          route: 'command',
          stage: 'jev_decision',
          tool: 'workflow_command',
          decision: result.decision,
          reason: result.reason ?? `Command ${result.decision}; shell execution remains controlled by the agent host.`,
          source: 'pipeline',
          latencyMs: Date.now() - started
        });
        appendConsoleRecord({
          agent: 'agy',
          route: 'command',
          stage: 'workflow_result',
          tool: 'workflow_result',
          decision: result.decision,
          reason: `Result returned to agent: ${result.decision}`,
          source: 'agent',
          latencyMs: Date.now() - started
        });
        vscode.window?.showInformationMessage?.(`Jev command decision: ${result.decision}${result.reason ? ` — ${result.reason}` : ''}`);
        return result;
      }
      if (!fastBrowser.status().running) {
        const started = await startBrowser(workspaceDir, extractPromptUrl(prompt));
        if (!started) return;
      } else {
        const current = fastBrowser.status();
        appendConsoleRecord({
          agent: 'browser',
          route: 'browser',
          stage: 'browser_session',
          tool: 'browser_session',
          url: current.pageUrl,
          controls: current.observedActions,
          decision: 'allow',
          reason: `Using active browser session: ${current.pageUrl ?? 'active target'} (${current.observedActions ?? 0} controls)`,
          source: 'pipeline'
        });
      }
      return runBrowserGoal(prompt);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      appendConsoleRecord({
        stage: 'host_error',
        tool: 'workflow_error',
        route,
        decision: 'deny',
        reason,
        source: 'pipeline'
      });
      vscode.window?.showErrorMessage?.(`Jev workflow failed: ${reason}`);
      return undefined;
    }
  };

  register('jev.setApiKey', async () => { const key = await vscode.window?.showInputBox?.({ prompt: 'Typesafe API key', password: true }); if (key && context.secrets) await setApiKey(context.secrets, key, homedir()); });
  register('jev.installGuard', async () => { const workspace = await chooseWorkspace(); if (workspace) return installGuard({ workspaceDir: workspace, homeDir: homedir(), guardSource: context.asAbsolutePath?.('guard.js') ?? 'guard.js' }); });
  register('jev.uninstallGuard', async () => { const workspace = await chooseWorkspace(); if (workspace) return uninstallGuard(workspace); });
  register('jev.testGuard', () => testGuard(context.asAbsolutePath?.('guard.js') ?? 'guard.js'));
  register('jev.startFastBrowser', () => startBrowser());
  register('jev.stopFastBrowser', async () => { const status = await fastBrowser.stop(); vscode.window?.showInformationMessage?.('Jev Fast Browser stopped'); return status; });
  register('jev.runFastBrowserGoal', async () => { if (!fastBrowser.status().running) { vscode.window?.showErrorMessage?.('Start Jev Fast Browser first.'); return; } const goal = await vscode.window?.showInputBox?.({ prompt: 'What should the fast browser do?' }); if (goal) return runBrowserGoal(goal); });
  register('jev.runWorkflow', runWorkflow);

  const provider = { resolveWebviewView(view: { webview: Webview }) {
    view.webview.options = { enableScripts: true };
    const read = (): DecisionRecord[] => existsSync(decisionLogPath) ? readFileSync(decisionLogPath, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as DecisionRecord]; } catch { return []; } }).slice(-200) : [];
    const refresh = () => { const records = read(); void view.webview.postMessage({ records: records.slice().reverse(), summary: summarize(records), browser: fastBrowser.status() }); };
    view.webview.html = renderConsoleHtml(read(), fastBrowser.status());
    const messages = view.webview.onDidReceiveMessage(message => {
      if (message.type === 'clearLogs') { try { writeFileSync(decisionLogPath, '', 'utf8'); } catch { /* best effort */ } refresh(); }
      if (message.type === 'startBrowser') void vscode.commands?.executeCommand?.('jev.startFastBrowser').finally(refresh);
      if (message.type === 'stopBrowser') void vscode.commands?.executeCommand?.('jev.stopFastBrowser').finally(refresh);
      if (message.type === 'runBrowser') void vscode.commands?.executeCommand?.('jev.runFastBrowserGoal').finally(refresh);
      if (message.type === 'runWorkflow') void vscode.commands?.executeCommand?.('jev.runWorkflow', message.prompt).finally(refresh);
    });
    const timer = setInterval(refresh, 1000);
    context.subscriptions?.push(messages);
    context.subscriptions?.push({ dispose: () => clearInterval(timer) });
  } };
  const viewDisposable = vscode.window?.registerWebviewViewProvider?.('jev.console', provider);
  if (viewDisposable) context.subscriptions?.push(viewDisposable);

  register('jev.openConsole', () => vscode.commands?.executeCommand?.('workbench.view.extension.jev'));
  register('jev.runCommand', async () => { const command = await vscode.window?.showInputBox?.({ prompt: 'What should Jev do?' }); if (!command) return; return routeCommand(command, collectContext(), { tool: 'search_error', confidence: 0 }, createRegistry(createExecutors({}))); });
}

export async function deactivate(): Promise<void> { await fastBrowser.stop(); }
