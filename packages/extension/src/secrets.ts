import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SecretStorageLike { store(key: string, value: string): Promise<void>; get?(key: string): Promise<string | undefined>; }
export const API_KEY_SECRET = "typesafeApiKey";

export async function setApiKey(secrets: SecretStorageLike, apiKey: string, homeDir: string): Promise<string> {
  const value = apiKey.trim();
  if (!value) throw new Error("A non-empty Typesafe API key is required");
  await secrets.store(API_KEY_SECRET, value);
  const dir = join(homeDir, ".jev");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "credentials");
  const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, `TYPESAFE_API_KEY=${value}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, target);
  return target;
}
