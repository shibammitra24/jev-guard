import type { BrowserSnapshot } from './types.js';
export class StalePageError extends Error { constructor() { super('Page changed since the browser decision'); this.name = 'StalePageError'; } }
export function assertFresh(observed: BrowserSnapshot, currentFingerprint: string): void { if (observed.fingerprint !== currentFingerprint) throw new StalePageError(); }
