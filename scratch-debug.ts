import { agyAdapter, isBrowserTool } from './packages/guard/src/adapters/agy';
import { loadToolPolicy } from './packages/guard/src/toolPolicyStore';
import { loadConfig } from './packages/guard/src/config';
import { resolveToolRule, assessOperation } from 'jev-core';

const payload = JSON.parse(JSON.stringify({
  toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf src' } },
  workspacePaths: ['D:\\Projects\\Hacknex 2026\\jev-demo-project'],
  conversationId: 'test',
}));

try {
  const call = agyAdapter.parse(payload);
  console.log('call:', call);
  const config = loadConfig();
  console.log('config.enabled:', config.enabled);
  const toolPolicy = loadToolPolicy();
  console.log('toolPolicy:', toolPolicy);
  const toolGate = config.enabled ? resolveToolRule(call.tool, toolPolicy) : undefined;
  console.log('toolGate:', toolGate);
  console.log('isBrowserTool:', isBrowserTool(call));
  const operation = assessOperation(call);
  console.log('operation:', operation);
} catch (error) {
  console.error('THREW:', error);
}
