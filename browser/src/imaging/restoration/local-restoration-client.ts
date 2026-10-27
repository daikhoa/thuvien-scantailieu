import type { ImageAsset, ImageDimensions } from '../../domain/document';
import type { AppliedRestorationStage, RestorationWarning } from './restoration-types';
import type { DocumentQualityProfile } from '../analysis/document-quality';
import type { DocumentDefectScores } from './restoration-policy';

export interface RestorationStrengths {
  readonly shadow: number;
  readonly lift: number;
  readonly contrast: number;
  readonly sharpen: number;
  readonly smooth: number;
}

export interface LocalRestorationAnalysis {
  /** Raw inference evidence; the C++ library owns the production appearance policy. */
  readonly defectScores?: DocumentDefectScores;
  readonly kind: 'analysis';
  readonly stages: readonly AppliedRestorationStage[];
  readonly classifierModel: string;
  readonly warnings: readonly RestorationWarning[];
  readonly protectColor: boolean;
  readonly quality?: DocumentQualityProfile;
  readonly strengths?: RestorationStrengths;
  readonly timings?: { readonly classifier: number; readonly qualityMetrics: number };
}

export interface LocalRestorationResult {
  readonly route: 'local' | 'enhanced';
  readonly stages: readonly AppliedRestorationStage[];
  readonly classifierModel: string;
  readonly provider: string | null;
  readonly warnings: readonly RestorationWarning[];
  readonly image?: ImageAsset;
}

export interface LocalRestorationClient {
  warmup?(): void;
  analyze?(
    source: LocalRestorationSource,
    signal: AbortSignal,
    options?: Pick<LocalRestorationRequestOptions, 'analysisKey'>,
  ): Promise<LocalRestorationAnalysis>;
  restore(
    source: LocalRestorationSource,
    signal: AbortSignal,
    options?: LocalRestorationRequestOptions,
  ): Promise<LocalRestorationResult>;
  dispose?(): void;
}

export type LocalRestorationSource =
  | Blob
  | {
      readonly kind: 'rgba-frame';
      readonly dimensions: ImageDimensions;
      readonly pixels: Uint8ClampedArray<ArrayBuffer>;
    };

export interface LocalRestorationRequestOptions {
  readonly analysisKey?: string;
  readonly reuseAnalysis?: boolean;
}

interface WorkerSuccess {
  readonly id: number;
  readonly kind: 'success';
  readonly result: LocalRestorationResult | LocalRestorationAnalysis;
}
interface WorkerFailure {
  readonly id: number;
  readonly kind: 'failure';
  readonly code: string;
}
type WorkerResponse =
  | WorkerSuccess
  | WorkerFailure
  | { readonly id: number; readonly kind: 'cancelled' }
  | { readonly kind: 'warmed' | 'warmup-failed' };

function abortError(): Error {
  const error = new Error('Local restoration cancelled.');
  error.name = 'AbortError';
  return error;
}

export function createLocalRestorationClient(): LocalRestorationClient {
  const worker = new Worker(new URL('./local-restoration.worker.ts', import.meta.url), {
    type: 'module',
  });
  let sequence = 0;
  let closed = false;
  let warmed = false;
  let warmupTimer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<
    number,
    {
      readonly resolve: (value: LocalRestorationResult | LocalRestorationAnalysis) => void;
      readonly reject: (error: Error) => void;
      readonly signal: AbortSignal;
      readonly abort: () => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
  const release = (id: number) => {
    const job = pending.get(id);
    if (job !== undefined) {
      clearTimeout(job.timer);
      job.signal.removeEventListener('abort', job.abort);
      pending.delete(id);
    }
    return job;
  };
  const close = (reason: Error) => {
    if (closed) return;
    closed = true;
    clearTimeout(warmupTimer);
    worker.terminate();
    for (const id of pending.keys()) release(id)?.reject(reason);
  };
  const fail = () => {
    close(new Error('Local restoration worker failed.'));
  };
  worker.addEventListener('error', fail);
  worker.addEventListener('messageerror', fail);
  worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    if (!('id' in response)) {
      clearTimeout(warmupTimer);
      if (response.kind === 'warmup-failed') warmed = false;
      return;
    }
    const job = release(response.id);
    if (job === undefined) return;
    if (response.kind === 'success') job.resolve(response.result);
    else if (response.kind === 'cancelled') job.reject(abortError());
    else job.reject(new Error('Local restoration failed.'));
  });
  const request = (
    operation: 'analyze' | 'restore',
    source: LocalRestorationSource,
    signal: AbortSignal,
    options: LocalRestorationRequestOptions,
  ): Promise<LocalRestorationAnalysis | LocalRestorationResult> => {
    if (closed) return Promise.reject(new Error('Local restoration worker is closed.'));
    if (signal.aborted) return Promise.reject(abortError());
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const abort = () => {
        const job = pending.get(id);
        job?.signal.removeEventListener('abort', abort);
        job?.reject(abortError());
        // Retain the watchdog until the worker acknowledges completion; cancel cannot interrupt ONNX.
        try {
          worker.postMessage({ operation: 'cancel', id });
        } catch {
          fail();
        }
      };
      const timer = setTimeout(() => {
        close(new Error('Local restoration timeout.'));
      }, 15_000);
      pending.set(id, { resolve, reject, signal, abort, timer });
      signal.addEventListener('abort', abort, { once: true });
      try {
        worker.postMessage(
          { operation, id, source, ...options },
          source instanceof Blob ? [] : [source.pixels.buffer],
        );
      } catch {
        fail();
      }
    });
  };
  return {
    warmup() {
      if (closed || warmed) return;
      warmed = true;
      warmupTimer = setTimeout(() => {
        close(new Error('Local restoration warmup timeout.'));
      }, 15_000);
      try {
        worker.postMessage({ operation: 'warmup' });
      } catch {
        fail();
      }
    },
    async analyze(source, signal, options = {}) {
      const value = await request('analyze', source, signal, options);
      if ('kind' in value) return value;
      throw new Error('Local restoration worker returned an invalid analysis.');
    },
    async restore(source, signal, options = {}) {
      const value = await request('restore', source, signal, options);
      if ('route' in value) return value;
      throw new Error('Local restoration worker returned an invalid result.');
    },
    dispose() {
      close(new Error('Local restoration worker is closed.'));
    },
  };
}
