import WebSocket, { type RawData } from 'ws';

export interface CdpTransport { call<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>; close(): void; }
interface Pending { resolve(value: unknown): void; reject(error: Error): void; }

export class CdpConnection implements CdpTransport {
  private nextId = 1; private readonly pending = new Map<number, Pending>();
  private constructor(private readonly socket: WebSocket) { socket.on('message', data => this.receive(data)); socket.on('close', () => this.failAll(new Error('CDP connection closed'))); socket.on('error', error => this.failAll(error)); }
  static async connect(httpEndpoint = 'http://127.0.0.1:9222'): Promise<CdpConnection> { const response = await fetch(`${httpEndpoint.replace(/\/$/, '')}/json/version`); if (!response.ok) throw new Error(`Chrome debugging endpoint returned ${response.status}`); const info = await response.json() as { webSocketDebuggerUrl?: string }; if (!info.webSocketDebuggerUrl) throw new Error('Chrome did not expose webSocketDebuggerUrl'); const socket = new WebSocket(info.webSocketDebuggerUrl); await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); }); return new CdpConnection(socket); }
  call<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> { const id = this.nextId++; return new Promise<T>((resolve, reject) => { this.pending.set(id, { resolve: value => resolve(value as T), reject }); this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), error => { if (error) { this.pending.delete(id); reject(error); } }); }); }
  close(): void { this.socket.close(); }
  private receive(data: RawData): void { let message: { id?: number; result?: unknown; error?: { message?: string } }; try { message = JSON.parse(data.toString()) as typeof message; } catch { return; } if (!message.id) return; const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); if (message.error) pending.reject(new Error(message.error.message ?? 'CDP command failed')); else pending.resolve(message.result); }
  private failAll(error: Error): void { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); }
}
