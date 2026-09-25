#!/usr/bin/env node
'use strict';

// Throwaway Phase-0 logging hook. Appends whatever Antigravity sends on
// stdin to a debug log and always prints {"decision":"allow"} so the agent
// is never actually blocked while we're capturing payloads. Never crashes
// or exits non-zero, per CLAUDE.md invariant #1, since this stands in for
// the real hook on a live agent session.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOG_DIR = path.join(os.homedir(), '.jev');
const LOG_FILE = path.join(LOG_DIR, 'hook-debug.log');

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main() {
  const raw = await readStdin();

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      argv: process.argv.slice(2),
      raw,
    };
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
  } catch {
    // Logging is best-effort; a write failure must never block the agent.
  }

  process.stdout.write('{"decision":"allow"}\n');
  process.exit(0);
}

main();
