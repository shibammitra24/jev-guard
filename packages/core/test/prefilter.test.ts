import { describe, expect, it } from 'vitest';
import { prefilter, isWildcardDelete, isTargetedDelete } from '../src/prefilter';

const call = (tool: string, args: Record<string, unknown> = {}) => ({
  agent: 'agy' as const,
  tool,
  args,
  raw: {},
});

describe('prefilter', () => {
  it('allows ordinary read-only tools', () => {
    expect(prefilter(call('list_dir', { DirectoryPath: 'src' }))).toBe('allow');
    expect(prefilter(call('view_file', { AbsolutePath: 'src/index.ts' }))).toBe('allow');
    expect(prefilter(call('read_url_content', { Url: 'https://example.com/docs' }))).toBe('allow');
  });

  it('checks suspicious paths and values', () => {
    expect(prefilter(call('view_file', { AbsolutePath: '.env' }))).toBe('check');
    expect(prefilter(call('list_dir', { DirectoryPath: 'secrets' }))).toBe('check');
  });

  it('never shortcuts shell tools', () => {
    expect(prefilter(call('run_command', { CommandLine: 'ls' }))).toBe('check');
    expect(prefilter(call('Bash', { command: 'pwd' }))).toBe('check');
  });

  // -------------------------------------------------------------------------
  // SSRF / local-file URL detection (Issue #2 — new threat coverage)
  // -------------------------------------------------------------------------
  describe('SSRF and local-file URL detection', () => {
    it('flags AWS metadata endpoint as check even if tool is in allow-list', () => {
      expect(prefilter(call('read_url_content', { Url: 'http://169.254.169.254/latest/meta-data/' }))).toBe('check');
    });

    it('flags GCP metadata endpoint', () => {
      expect(prefilter(call('read_url_content', { Url: 'http://169.254.169.254/computeMetadata/v1/' }))).toBe('check');
    });

    it('flags loopback (localhost) URL', () => {
      expect(prefilter(call('read_url_content', { Url: 'http://localhost:8080/admin' }))).toBe('check');
    });

    it('flags 127.x loopback URL', () => {
      expect(prefilter(call('read_url_content', { Url: 'http://127.0.0.1/admin' }))).toBe('check');
    });

    it('flags file:// protocol URL', () => {
      expect(prefilter(call('read_url_content', { Url: 'file:///etc/passwd' }))).toBe('check');
    });

    it('allows safe external HTTPS URLs', () => {
      expect(prefilter(call('read_url_content', { Url: 'https://api.github.com/repos' }))).toBe('allow');
    });

    it('allows safe HTTP doc URLs', () => {
      expect(prefilter(call('read_url_content', { Url: 'http://example.com/page' }))).toBe('allow');
    });
  });

  // -------------------------------------------------------------------------
  // Guard-tampering detection (Issue #2 — new threat coverage)
  // -------------------------------------------------------------------------
  describe('guard-tampering path detection', () => {
    it('flags write to .agents/hooks.json (replaces the guard hook)', () => {
      expect(prefilter(call('write_to_file', { TargetFile: '.agents/hooks.json', CodeContent: '{}' }))).toBe('check');
    });

    it('flags write to .agents\\hooks.json (Windows path variant)', () => {
      expect(prefilter(call('write_to_file', { TargetFile: '.agents\\hooks.json', CodeContent: '{}' }))).toBe('check');
    });

    it('flags run_command that overwrites guard.js', () => {
      expect(prefilter(call('run_command', { CommandLine: 'echo "" > dist/guard.js' }))).toBe('check');
    });

    it('allows writes to unrelated files', () => {
      expect(prefilter(call('write_to_file', { TargetFile: 'src/index.ts', CodeContent: 'export {};' }))).toBe('check');
    });
  });

  // -------------------------------------------------------------------------
  // Wildcard vs targeted delete detection (Issue #1 — false-positive deny)
  // -------------------------------------------------------------------------
  describe('isWildcardDelete', () => {
    it('detects rm -rf as wildcard', () => {
      expect(isWildcardDelete(call('run_command', { CommandLine: 'rm -rf ./src' }))).toBe(true);
    });

    it('detects rm -fr (reversed flags) as wildcard', () => {
      expect(isWildcardDelete(call('run_command', { CommandLine: 'rm -fr .' }))).toBe(true);
    });

    it('detects del /s /q as wildcard', () => {
      expect(isWildcardDelete(call('run_command', { CommandLine: 'del /s /q node_modules' }))).toBe(true);
    });

    it('detects Remove-Item -Recurse as wildcard', () => {
      expect(isWildcardDelete(call('run_command', { CommandLine: 'Remove-Item ./dist -Recurse' }))).toBe(true);
    });

    it('does NOT flag a targeted single-file rm as wildcard', () => {
      expect(isWildcardDelete(call('run_command', { CommandLine: 'rm old-file.ts' }))).toBe(false);
    });

    it('returns false for non-command-line calls', () => {
      expect(isWildcardDelete(call('view_file', { AbsolutePath: 'src/index.ts' }))).toBe(false);
    });
  });

  describe('isTargetedDelete', () => {
    it('identifies rm <file> as targeted', () => {
      expect(isTargetedDelete(call('run_command', { CommandLine: 'rm old-service.ts' }))).toBe(true);
    });

    it('identifies del <file> as targeted', () => {
      expect(isTargetedDelete(call('run_command', { CommandLine: 'del output.log' }))).toBe(true);
    });

    it('identifies Remove-Item <file> as targeted', () => {
      expect(isTargetedDelete(call('run_command', { CommandLine: 'Remove-Item ./old.log' }))).toBe(true);
    });

    it('does NOT flag rm -rf as targeted', () => {
      expect(isTargetedDelete(call('run_command', { CommandLine: 'rm -rf ./src' }))).toBe(false);
    });

    it('does NOT flag wildcard removal as targeted', () => {
      expect(isTargetedDelete(call('run_command', { CommandLine: 'rm *.log' }))).toBe(false);
    });
  });
});

// -------------------------------------------------------------------------
// Policy: targeted-delete ask-downgrade (Issue #1)
// -------------------------------------------------------------------------
describe('decide — targeted-delete downgrade', () => {
  it('downgrades deny → ask when userExplicit ≥ 0.75 and not wildcard', async () => {
    const { decide } = await import('../src/policy.js');
    const signals = {
      destructive: 0.9,   // would normally deny (> denyNoul=0.85)
      secrets: 0,
      exfiltration: 0,
      outsideWorkspace: 0,
      risk: 1.0,          // below denyRisk=2.5
      userExplicit: 0.9,  // user explicitly asked for it
      isWildcard: false,  // not rm -rf
    };
    const result = decide(signals, 'agy');
    expect(result.verdict).toBe('ask');
    expect(result.reason).toContain('confirm');
  });

  it('does NOT downgrade if isWildcard is true', async () => {
    const { decide } = await import('../src/policy.js');
    const signals = {
      destructive: 0.9,
      secrets: 0,
      exfiltration: 0,
      outsideWorkspace: 0,
      risk: 1.0,
      userExplicit: 0.9,
      isWildcard: true,   // wildcard — no downgrade allowed
    };
    const result = decide(signals, 'agy');
    expect(result.verdict).toBe('deny');
  });

  it('does NOT downgrade if risk is at or above denyRisk', async () => {
    const { decide } = await import('../src/policy.js');
    const signals = {
      destructive: 0.9,
      secrets: 0,
      exfiltration: 0,
      outsideWorkspace: 0,
      risk: 2.5,          // at denyRisk threshold
      userExplicit: 0.9,
      isWildcard: false,
    };
    const result = decide(signals, 'agy');
    expect(result.verdict).toBe('deny');
  });

  it('does NOT downgrade if userExplicit is low', async () => {
    const { decide } = await import('../src/policy.js');
    const signals = {
      destructive: 0.9,
      secrets: 0,
      exfiltration: 0,
      outsideWorkspace: 0,
      risk: 1.0,
      userExplicit: 0.3,  // AI-inferred, not user-explicit
      isWildcard: false,
    };
    const result = decide(signals, 'agy');
    expect(result.verdict).toBe('deny');
  });
});
