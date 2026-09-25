import type { EditorContext } from './context.js';
export interface RouterTool { name: string; description: string; destructive?: boolean; resolveArgs(ctx: EditorContext, command: string): Promise<Record<string, unknown> | null>; execute(args: Record<string, unknown>): Promise<void>; }
export interface RouterRegistry { tools: RouterTool[]; byName(name: string): RouterTool | undefined; }
export function createRegistry(tools: RouterTool[]): RouterRegistry { return { tools, byName: (name) => tools.find(tool => tool.name === name) }; }
