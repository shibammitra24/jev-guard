import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { runGuard, type RunDeps } from './main';
import { loadConfig } from './config';
import { createLogger } from './log';
import { redactBrowserLogEntry, isSameWorkspace } from './security';
import type { GuardedBrowserRequest, GuardedBrowserResponse } from 'jev-core';

export interface GuardServerOptions {
  workspace: string;
  host?: string;
  port?: number;
  token?: string;
  deps?: RunDeps;
}

export interface GuardServer {
  server: Server;
  token: string;
  port: number;
  close(): Promise<void>;
  /**
   * Invalidate the session immediately.
   *
   * All requests received after this call return HTTP 503.  Call this when the
   * workspace changes or the extension is deactivating so that the sidecar
   * cannot execute further browser actions under the previous workspace identity.
   */
  invalidate(): void;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      data += chunk;
      if (data.length > 1024 * 1024) reject(new Error('request too large'));
    });
    request.on('end', () => resolve(data));
    request.on('error', reject);
  });
}

export async function startGuardServer(options: GuardServerOptions): Promise<GuardServer> {
  const token = options.token ?? randomBytes(24).toString('hex');
  const host = options.host ?? '127.0.0.1';

  // Phase 5: invalidation flag — set by invalidate(), checked on every request
  let invalidated = false;

  const server = createServer(async (request, response) => {
    try {
      // Phase 5: reject all requests after invalidation (workspace switch / deactivation)
      if (invalidated) {
        return send(response, 503, { error: 'session invalidated' });
      }

      if (request.method !== 'POST' || request.url !== '/v1/decide') {
        return send(response, 404, { error: 'not found' });
      }

      // Phase 5: 401 before reading the body to avoid timing information leaks
      if (request.headers.authorization !== `Bearer ${token}`) {
        return send(response, 401, { error: 'unauthorized' });
      }

      const input = JSON.parse(await readBody(request)) as GuardedBrowserRequest;

      // Phase 5: workspace validation using case-aware path comparison
      if (
        input.provenance !== 'browser-sidecar' ||
        !isSameWorkspace(input.workspace, options.workspace) ||
        !isSameWorkspace(input.action.workspace, options.workspace)
      ) {
        return send(response, 403, { error: 'workspace mismatch' });
      }

      const started = Date.now();

      // Build a synthetic guard payload from the browser request.
      // Phase 5: visibleText is included for the guard evaluation but will be
      // stripped from the log entry by redactBrowserLogEntry() below.
      const payload = JSON.stringify({
        toolCall: {
          name: `browser_${input.action.kind}`,
          args: { action: input.action, page: input.page },
        },
        workspacePaths: [options.workspace],
        conversationId: 'browser-sidecar',
      });

      const baseLogger = options.deps?.logger ?? createLogger(
        (options.deps?.config ?? loadConfig(options.deps?.homeDir)).logPath,
      );

      // Phase 5: wrap the base logger to strip sensitive page content and cap
      // field lengths before any log entry is written to disk.
      const logger = {
        ...baseLogger,
        append(record: unknown) {
          const raw = record && typeof record === 'object' && !Array.isArray(record)
            ? record as Record<string, unknown>
            : { record };

          // Add browser-specific fields
          let urlOrigin = input.page.url;
          try { urlOrigin = new URL(input.page.url).origin; } catch { /* keep raw url on parse failure */ }

          const enriched: Record<string, unknown> = {
            ...raw,
            agent: 'browser',
            actionId: input.action.id,
            urlOrigin,
          };

          // Redact before writing — strips visibleText, caps strings, asserts no key leak
          baseLogger.append(redactBrowserLogEntry(enriched));
        },
      };

      const rendered = await runGuard(payload, ['--agent', 'agy'], {
        ...options.deps,
        logger,
        homeDir: options.deps?.homeDir,
      });

      const parsed = JSON.parse(rendered) as { decision?: string; reason?: string };
      const decision =
        parsed.decision === 'deny' ? 'deny'
        : parsed.decision === 'ask' || parsed.decision === 'force_ask' ? 'ask'
        : 'allow';

      return send(response, 200, {
        decision,
        reason: parsed.reason,
        latencyMs: Date.now() - started,
      } satisfies GuardedBrowserResponse);
    } catch (error) {
      return send(response, 400, { error: error instanceof Error ? error.message : 'bad request' });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port ?? 0;

  return {
    server,
    token,
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      ),
    // Phase 5: mark session as dead; subsequent requests → 503
    invalidate: () => { invalidated = true; },
  };
}
