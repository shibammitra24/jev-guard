import type { EditorContext } from './context.js';
import type { RouterTool } from './registry.js';
export interface RouterHost { openExternal?(url: string): Promise<void>; openFile?(path: string): Promise<void>; runTerminal?(command: string): Promise<void>; }
const url = (command: string) => command.match(/https?:\/\/[^\s]+/)?.[0];
export function createExecutors(host: RouterHost): RouterTool[] {
  return [
    { name: 'search_error', description: 'Search the current diagnostic or terminal error on the web.', async resolveArgs(ctx, command) { const query = ctx.diagnostic ?? ctx.lastTerminalError ?? command; return { url: `https://www.google.com/search?q=${encodeURIComponent(query)}` }; }, async execute(args) { await host.openExternal?.(String(args.url)); } },
    { name: 'open_url', description: 'Open a URL or documentation page in the browser.', async resolveArgs(_ctx, command) { const found = url(command); return found ? { url: found } : command.toLowerCase().includes('react') ? { url: 'https://react.dev' } : null; }, async execute(args) { await host.openExternal?.(String(args.url)); } },
    { name: 'open_file', description: 'Open a file in the editor.', async resolveArgs(ctx, command) { const path = command.match(/[\w./\\-]+\.[\w]+/)?.[0] ?? ctx.activeFile; return path ? { path } : null; }, async execute(args) { await host.openFile?.(String(args.path)); } },
    { name: 'run_tests', description: 'Run the project tests.', async resolveArgs(ctx) { return { command: ctx.languageId === 'python' ? 'pytest' : 'npm test' }; }, async execute(args) { await host.runTerminal?.(String(args.command)); } },
    { name: 'git_diff', description: 'Show the current git diff.', async resolveArgs(ctx) { return { command: ctx.activeFile ? `git diff -- ${ctx.activeFile}` : 'git diff' }; }, async execute(args) { await host.runTerminal?.(String(args.command)); } },
  ];
}
