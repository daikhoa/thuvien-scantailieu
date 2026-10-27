export const SHADOW_FAILURE_CODES = [
  'download',
  'model-invalid',
  'memory',
  'runtime',
  'inference',
  'timeout',
  'busy',
] as const;
export type { EnhancementFailureCode as ShadowFailureCode } from '../../domain/document';
import type { EnhancementFailureCode as ShadowFailureCode } from '../../domain/document';
export class ShadowRuntimeError extends Error {
  constructor(readonly code: ShadowFailureCode) {
    super(`shadow-${code}`);
  }
}
export function shadowFailureCode(error: unknown, fallback: ShadowFailureCode): ShadowFailureCode {
  if (error instanceof ShadowRuntimeError) return error.code;
  // A bounded classification, never a raw model/browser error or document data.
  const message = error instanceof Error ? error.message : '';
  return /out of memory|out-of-memory|allocation failed|memory access out of bounds|cannot enlarge memory/i.test(
    message,
  )
    ? 'memory'
    : fallback;
}
