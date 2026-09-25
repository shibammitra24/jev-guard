import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { NormalizedToolCall } from './types.js';

export type OperationClass =
  | 'read'
  | 'workspace_edit'
  | 'workspace_build'
  | 'package_network'
  | 'secret_access'
  | 'exfiltration'
  | 'destructive'
  | 'outside_workspace'
  | 'guard_tampering'
  | 'unknown';

export interface OperationAssessment {
  operationClass: OperationClass;
  targetPath?: string;
  insideWorkspace: boolean;
  sensitive: boolean;
  reversibleEdit: boolean;
  reason: string;
}

const SECRET_PATH = /(^|[\\/])(?:\.env(?:\.[^\\/]*)?|credentials?|secrets?|tokens?|id_rsa|service-account[^\\/]*\.json|[^\\/]+\.(?:pem|key))$/i;
const GUARD_PATH = /(^|[\\/])\.agents[\\/]hooks\.json$|(?:^|[\\/])(?:guard\.js|jev-guard(?:\.js)?)$/i;
const WRITE_TOOLS = new Set([
  'write_to_file', 'write_file', 'create_file', 'edit_file', 'replace_file_content',
  'apply_patch', 'save_file', 'create_or_replace_file',
]);
const READ_TOOLS = new Set(['list_dir', 'view_file', 'read_file', 'Read', 'Glob', 'Grep', 'codebase_search', 'view_code_item', 'read_url_content']);
const PATH_KEYS = ['AbsolutePath', 'TargetFile', 'FilePath', 'filePath', 'path', 'Path', 'filename', 'FileName', 'uri'];

function stringArg(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function isInsideWorkspace(target: string, workspace: string | undefined): boolean {
  if (!workspace) return false;
  const root = resolve(workspace);
  const full = isAbsolute(target) ? resolve(target) : resolve(root, target);
  const delta = relative(root, full);
  return delta === '' || (!delta.startsWith(`..${sep}`) && delta !== '..' && !isAbsolute(delta));
}

function commandLine(call: NormalizedToolCall): string {
  return stringArg(call.args, ['CommandLine', 'command', 'Command', 'cmd']) ?? '';
}

/** Only the project-manifest dependency install is routine. Installing an
 * arbitrary named package or executing npx remains contextual. */
function isDeclaredDependencyInstall(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, ' ');
  return /^npm (?:install|ci)(?: --(?:no-audit|no-fund|legacy-peer-deps))*$/i.test(normalized);
}

export function assessOperation(call: NormalizedToolCall): OperationAssessment {
  const targetPath = stringArg(call.args, PATH_KEYS);
  const insideWorkspace = targetPath ? isInsideWorkspace(targetPath, call.workspace) : false;
  const sensitive = Boolean(targetPath && SECRET_PATH.test(targetPath));
  const guardTampering = Boolean(targetPath && GUARD_PATH.test(targetPath));

  if (guardTampering) return { operationClass: 'guard_tampering', targetPath, insideWorkspace, sensitive, reversibleEdit: false, reason: 'guard configuration or bundle target' };
  if (sensitive) return { operationClass: 'secret_access', targetPath, insideWorkspace, sensitive, reversibleEdit: false, reason: 'sensitive credential target' };

  if (WRITE_TOOLS.has(call.tool)) {
    if (!targetPath || !insideWorkspace) return { operationClass: 'outside_workspace', targetPath, insideWorkspace, sensitive, reversibleEdit: false, reason: 'write target is outside the selected workspace or unavailable' };
    return { operationClass: 'workspace_edit', targetPath, insideWorkspace, sensitive, reversibleEdit: true, reason: 'bounded non-secret edit inside selected workspace' };
  }

  if (READ_TOOLS.has(call.tool)) return { operationClass: 'read', targetPath, insideWorkspace, sensitive, reversibleEdit: false, reason: 'read-only operation' };

  if (call.tool === 'run_command') {
    const command = commandLine(call);
    if (/\b(?:rm\s+-[a-z]*[rf]|del\s+\/?[sq]|Remove-Item\b.*-Recurse|git\s+clean\b|rmdir\s+\/s)\b/i.test(command)) {
      return { operationClass: 'destructive', insideWorkspace: false, sensitive: false, reversibleEdit: false, reason: 'recursive or wildcard destructive command' };
    }
    if (/\b(?:curl|wget|Invoke-WebRequest)\b.*(?:\.env|credentials?|secrets?|tokens?|id_rsa)/i.test(command)) {
      return { operationClass: 'exfiltration', insideWorkspace: false, sensitive: true, reversibleEdit: false, reason: 'network command references local sensitive data' };
    }
    if (isDeclaredDependencyInstall(command)) {
      return { operationClass: 'workspace_build', insideWorkspace: Boolean(call.workspace), sensitive: false, reversibleEdit: false, reason: 'installing dependencies declared by the selected workspace manifest' };
    }
    if (/^\s*(?:npm\s+run\s+(?:dev|build|test|lint|format|typecheck)|npm\s+(?:test|run)|git\s+(?:status|diff))\b/i.test(command)) {
      return { operationClass: 'workspace_build', insideWorkspace: Boolean(call.workspace), sensitive: false, reversibleEdit: false, reason: 'routine workspace build/test command' };
    }
    if (/^\s*(?:npm\s+(?:install|ci)|npx\b)/i.test(command)) {
      return { operationClass: 'package_network', insideWorkspace: Boolean(call.workspace), sensitive: false, reversibleEdit: false, reason: 'package-manager download or package execution' };
    }
  }

  return { operationClass: 'unknown', targetPath, insideWorkspace, sensitive, reversibleEdit: false, reason: 'requires contextual Jev evaluation' };
}

export function isRoutineWorkspaceOperation(assessment: OperationAssessment): boolean {
  return assessment.operationClass === 'workspace_edit' || assessment.operationClass === 'workspace_build';
}
