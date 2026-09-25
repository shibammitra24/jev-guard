import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installGuard, uninstallGuard } from "../src/installer.js";
import { setApiKey } from "../src/secrets.js";
import { renderConsoleHtml, summarize } from "../src/console.js";
import { clearDecisionLog } from "../src/extension.js";
import { testGuard } from "../src/testGuard.js";

describe("phase 4", () => {
  it("installs and uninstalls only the named Antigravity handler", () => {
    const home = mkdtempSync(join(tmpdir(), "jev-home-")); const source = join(home, "guard.js"); writeFileSync(source, "guard"); const workspace = join(home, "workspace");
    const config = join(workspace, ".agents", "hooks.json"); const { mkdirSync } = require("node:fs") as typeof import("node:fs"); mkdirSync(join(workspace, ".agents"), { recursive: true }); writeFileSync(config, JSON.stringify({ other: { enabled: true } }));
    installGuard({ workspaceDir: workspace, homeDir: home, guardSource: source, now: new Date("2026-01-01T00:00:00Z") });
    expect(JSON.parse(readFileSync(config, "utf8")).other.enabled).toBe(true); const installed = JSON.parse(readFileSync(config, "utf8")); expect(installed["jev-guard"]).toBeDefined(); expect(installed["jev-guard"].PreToolUse[0].hooks[0].command).toMatch(/^node [A-Z]:\//); expect(installed["jev-guard"].PreToolUse[0].hooks[0].command).not.toContain('"');
    uninstallGuard(workspace); expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ other: { enabled: true } });
  });
  it("writes credentials and renders timestamped workflow metrics with log clearing", async () => { const home = mkdtempSync(join(tmpdir(), "jev-home-")); const stored: string[] = []; await setApiKey({ store: async (_k, v) => { stored.push(v); } }, " key ", home); expect(stored).toEqual(["key"]); const html = renderConsoleHtml([{ ts: "2026-09-24T12:00:00.000Z", decision: "deny", agent: "browser", tool: "browser_click", latencyMs: 4 }]); expect(html).toContain("Timestamp"); expect(html).toContain("Protected workflow"); expect(html).toContain("Run through Jev"); expect(html).toContain("runWorkflow"); expect(html).toContain("Clear logs"); expect(html).toContain("startBrowser"); expect(html).toContain("Fast Browser"); expect(summarize([{ decision: "deny", agent: "browser" }])).toMatchObject({ denied: 1, browser: 1 }); });
  it("truncates the on-disk log used by the clear button", () => { const home = mkdtempSync(join(tmpdir(), "jev-home-")); const path = join(home, "decisions.jsonl"); writeFileSync(path, '{"decision":"deny"}\n'); clearDecisionLog(path); expect(readFileSync(path, "utf8")).toBe(""); });
  it("runs canned smoke payloads through an injected runner", async () => { const calls: string[] = []; const result = await testGuard("guard.js", async (_path, input) => { calls.push(input); return { decision: input.includes("rm -rf") ? "deny" : "allow" }; }); expect(result.safe.decision).toBe("allow"); expect(result.dangerous.decision).toBe("deny"); expect(calls).toHaveLength(2); });
});
