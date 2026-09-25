import type { BrowserActionKind } from 'jev-core';
export interface ObservedAction { id: string; node?: number; kind: BrowserActionKind; label: string; role?: string; value?: string; currentValue?: string; optionValue?: string; }
export interface BrowserSnapshot { url: string; title: string; visibleText: string; fingerprint: string; actions: ObservedAction[]; omittedActions?: number; }
export interface BrowserChoice { operation: string; target?: string; confidence: number; probabilities: Record<string, number>; }
