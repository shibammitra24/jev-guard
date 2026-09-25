import { runGuard } from 'jev-guard-cli';

export type WorkflowRoute = 'browser' | 'command';
export interface CommandWorkflowResult { route: 'command'; decision: 'allow' | 'ask' | 'deny'; reason?: string; }

const BROWSER_WORDS = /\b(browser|browse|website|web page|url|navigate|click|open page|search (?:for|the web)|fill (?:the )?form)\b/i;
const COMMAND_WORDS = /\b(rm|del|remove-item|powershell|bash|shell|terminal|command|npm|git|curl|wget|copy|move|delete|file|folder|directory)\b/i;

export function extractPromptUrl(prompt: string): string | undefined {
  const match = prompt.match(/https?:\/\/[^\s"'<>]+/i);
  return match?.[0];
}

export function classifyWorkflowPrompt(prompt: string): WorkflowRoute {
  if (extractPromptUrl(prompt) || BROWSER_WORDS.test(prompt)) return 'browser';
  if (COMMAND_WORDS.test(prompt)) return 'command';
  return 'command';
}

export async function evaluateCommandPrompt(prompt: string, workspace: string, homeDir?: string): Promise<CommandWorkflowResult> {
  const payload = JSON.stringify({ toolCall: { name: 'run_command', args: { command: prompt } }, workspacePaths: [workspace], conversationId: 'jev-workflow' });
  const rendered = await runGuard(payload, ['--agent', 'agy'], { homeDir });
  const parsed = JSON.parse(rendered) as { decision?: string; reason?: string };
  const decision = parsed.decision === 'deny' ? 'deny' : parsed.decision === 'ask' || parsed.decision === 'force_ask' ? 'ask' : 'allow';
  return { route: 'command', decision, reason: parsed.reason };
}
