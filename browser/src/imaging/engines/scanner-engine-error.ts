import type { ProcessingFailure } from '../../domain/document';

export class ScannerEngineError extends Error {
  constructor(readonly code: ProcessingFailure['code']) {
    super(`Scanner engine operation ${code}.`);
    this.name = 'ScannerEngineError';
  }
}
