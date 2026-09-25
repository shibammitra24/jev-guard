import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const AGY_HANDLER_NAME = "jev-guard";
export interface InstallOptions { workspaceDir: string; homeDir?: string; guardSource: string; now?: Date; }
export function agyConfigPath(workspaceDir: string): string { return join(resolve(workspaceDir), ".agents", "hooks.json"); }
export function guardDisabledPath(workspaceDir: string): string { return join(resolve(workspaceDir), ".jev", "guard-disabled"); }
export function guardDestination(homeDir = homedir()): string { return join(homeDir, ".jev", "bin", "guard.js"); }
export function guardHandler(homeDir = homedir()) { const path = guardDestination(homeDir).replace(/\\/g, '/'); return { enabled: true, PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `node ${path} --agent agy`, timeout: 90 }] }] }; }

function atomicWrite(path: string, text: string): void { mkdirSync(dirname(path), { recursive: true }); const temp = `${path}.tmp-${process.pid}`; writeFileSync(temp, text, "utf8"); renameSync(temp, path); }
function parseConfig(path: string): Record<string, unknown> { if (!existsSync(path)) return {}; const raw = readFileSync(path, "utf8"); const value: unknown = JSON.parse(raw); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("hooks.json must contain a JSON object"); return value as Record<string, unknown>; }

export function installGuard(options: InstallOptions): { configPath: string; backupPath?: string; guardPath: string } {
  if (!isAbsolute(options.workspaceDir) || !existsSync(options.workspaceDir) || !statSync(options.workspaceDir).isDirectory()) throw new Error("Choose an existing absolute workspace folder");
  const home = options.homeDir ?? homedir(); const configPath = agyConfigPath(options.workspaceDir); const root = parseConfig(configPath);
  try { unlinkSync(guardDisabledPath(options.workspaceDir)); } catch { /* not disabled or already removed */ }
  let backupPath: string | undefined;
  if (existsSync(configPath)) { const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-"); backupPath = join(home, ".jev", "backups", stamp, "hooks.json"); mkdirSync(dirname(backupPath), { recursive: true }); copyFileSync(configPath, backupPath); }
  root[AGY_HANDLER_NAME] = guardHandler(home);
  atomicWrite(configPath, `${JSON.stringify(root, null, 2)}\n`);
  const destination = guardDestination(home); mkdirSync(dirname(destination), { recursive: true }); copyFileSync(options.guardSource, destination);
  return { configPath, backupPath, guardPath: destination };
}

export function uninstallGuard(workspaceDir: string): { configPath: string; removed: boolean } {
  const configPath = agyConfigPath(workspaceDir);
  mkdirSync(join(resolve(workspaceDir), ".jev"), { recursive: true });
  writeFileSync(guardDisabledPath(workspaceDir), 'disabled\n', 'utf8');
  if (!existsSync(configPath)) return { configPath, removed: false };
  const root = parseConfig(configPath);
  // Remove current and legacy Jev handlers from this workspace only. Other
  // Antigravity handlers remain untouched.
  const jevKeys = Object.keys(root).filter(key => /^jev-guard(?:-|$)/i.test(key));
  const removed = jevKeys.length > 0;
  for (const key of jevKeys) delete root[key];
  if (removed) atomicWrite(configPath, `${JSON.stringify(root, null, 2)}\n`);
  return { configPath, removed };
}
