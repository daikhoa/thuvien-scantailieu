import type { LocalRestorationAnalysis } from '../restoration/local-restoration-client';
import type {
  DocumentCorners,
  FilterMode,
  ImageDimensions,
  QuarterTurn,
} from '../../domain/document';
import { isValidImageDimensions } from '../geometry/coordinates';
import { MAX_WORKING_IMAGE_PIXELS, MAX_WORKING_IMAGE_SIDE } from '../working-image-limits';
import type {
  ClassicalBackend,
  RgbaBackendInput,
  RasterWarpRequest,
} from './scanic-backend-contract';
import { ScannerEngineError } from './scanic-backend-contract';

export type ScanicWorkerCommand =
  | { readonly operation: 'initialize' }
  | { readonly operation: 'dispose' }
  | { readonly operation: 'detect'; readonly input: RgbaBackendInput }
  | ({ readonly operation: 'warp-asset' } & RasterWarpRequest)
  | {
      readonly operation: 'warp';
      readonly input: RgbaBackendInput;
      readonly corners: DocumentCorners;
      readonly rotation: QuarterTurn;
      readonly filter: FilterMode;
      readonly maximumOutputLongSide?: number;
      readonly analysis?: LocalRestorationAnalysis;
    };
export type ScanicWorkerRequest = ScanicWorkerCommand & { readonly id: number };

export type ScanicWorkerResponse =
  | { readonly id: number; readonly kind: 'success'; readonly output: unknown }
  | { readonly id: number; readonly kind: 'failure'; readonly code: 'unavailable' | 'failed' };

function isImageDimensions(value: unknown): value is ImageDimensions {
  return (
    typeof value === 'object' &&
    value !== null &&
    'width' in value &&
    'height' in value &&
    typeof value.width === 'number' &&
    typeof value.height === 'number' &&
    isValidImageDimensions({ width: value.width, height: value.height })
  );
}

function isRgbaBackendInput(value: unknown): value is RgbaBackendInput {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('dimensions' in value) ||
    !('pixels' in value)
  ) {
    return false;
  }
  const { dimensions, pixels } = value;
  return (
    isImageDimensions(dimensions) &&
    Math.max(dimensions.width, dimensions.height) <= MAX_WORKING_IMAGE_SIDE &&
    dimensions.width * dimensions.height <= MAX_WORKING_IMAGE_PIXELS &&
    pixels instanceof Uint8ClampedArray &&
    pixels.buffer instanceof ArrayBuffer &&
    pixels.byteLength === dimensions.width * dimensions.height * 4
  );
}

/** Each instance owns its worker, and thus Scanic's otherwise non-disposable WASM singleton. */
export function createScanicWorkerBackend(): ClassicalBackend {
  if (typeof Worker === 'undefined') throw new ScannerEngineError('unavailable');
  const worker = new Worker(new URL('./scanic-classical.worker.ts', import.meta.url), {
    type: 'module',
    name: 'scanic-ml-1.6.0',
  });
  let closed = false;
  let nextId = 0;
  let retiring: Promise<void> | undefined;
  let retirement: { id: number; resolve: () => void; timer: ReturnType<typeof setTimeout> } | null =
    null;
  let current: {
    readonly id: number;
    readonly operation: ScanicWorkerRequest['operation'];
    readonly resolve: (output: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null = null;

  const fail = (code: 'failed' | 'unavailable' | 'timeout') => {
    const job = current;
    current = null;
    if (job !== null) clearTimeout(job.timer);
    job?.reject(new ScannerEngineError(code));
  };

  const onMessage = (event: MessageEvent<unknown>) => {
    const reply = event.data;
    if (retirement !== null) {
      if (
        typeof reply === 'object' &&
        reply !== null &&
        'id' in reply &&
        reply.id === retirement.id &&
        'kind' in reply &&
        reply.kind === 'success'
      )
        close('unavailable');
      return;
    }
    if (
      typeof reply !== 'object' ||
      reply === null ||
      !('id' in reply) ||
      current === null ||
      reply.id !== current.id ||
      !('kind' in reply)
    ) {
      close('failed');
      return;
    }
    if (reply.kind === 'failure') {
      close('code' in reply && reply.code === 'unavailable' ? 'unavailable' : 'failed');
      return;
    }
    if (reply.kind !== 'success' || !('output' in reply)) {
      close('failed');
      return;
    }
    if (
      (current.operation === 'warp' || current.operation === 'warp-asset') &&
      !isRgbaBackendInput(reply.output)
    ) {
      close('failed');
      return;
    }
    const job = current;
    current = null;
    clearTimeout(job.timer);
    job.resolve(reply.output);
  };
  const onError = () => {
    close('failed');
  };
  worker.addEventListener('message', onMessage);
  worker.addEventListener('error', onError);
  worker.addEventListener('messageerror', onError);

  function close(code: 'failed' | 'unavailable' | 'timeout'): void {
    if (closed) return;
    closed = true;
    worker.removeEventListener('message', onMessage);
    worker.removeEventListener('error', onError);
    worker.removeEventListener('messageerror', onError);
    worker.terminate();
    fail(code);
    if (retirement !== null) {
      const complete = retirement;
      retirement = null;
      clearTimeout(complete.timer);
      complete.resolve();
    }
  }

  function request(command: ScanicWorkerCommand): Promise<unknown> {
    if (closed || retiring !== undefined || current !== null)
      return Promise.reject(new ScannerEngineError('unavailable'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          close('timeout');
        },
        command.operation === 'warp' || command.operation === 'warp-asset' ? 90_000 : 30_000,
      );
      current = { id, operation: command.operation, resolve, reject, timer };
      try {
        const message: ScanicWorkerRequest = { ...command, id };
        if ('input' in command) worker.postMessage(message, [command.input.pixels.buffer]);
        else worker.postMessage(message);
      } catch {
        close('failed');
      }
    });
  }

  return {
    async initialize() {
      await request({ operation: 'initialize' });
    },
    detect: (input) => request({ operation: 'detect', input }),
    async warp(input, corners, rotation, filter, maximumOutputLongSide, analysis) {
      const output = await request({
        operation: 'warp',
        input,
        corners,
        rotation,
        filter,
        ...(maximumOutputLongSide === undefined ? {} : { maximumOutputLongSide }),
        ...(analysis === undefined ? {} : { analysis }),
      });
      if (!isRgbaBackendInput(output)) throw new ScannerEngineError('failed');
      return output;
    },
    async warpAsset(parameters) {
      const output = await request({ operation: 'warp-asset', ...parameters });
      if (!isRgbaBackendInput(output)) throw new ScannerEngineError('failed');
      return output;
    },
    dispose() {
      if (retiring !== undefined) return retiring;
      if (closed) return Promise.resolve();
      // Let the realm terminate its nested shadow worker before destroying its owner.
      // A blocked WASM call must still be cancellable, so force termination after 1 s.
      fail('unavailable');
      retiring = new Promise<void>((resolve) => {
        const id = ++nextId;
        retirement = { id, resolve, timer: setTimeout(() => close('unavailable'), 1000) };
        try {
          worker.postMessage({ operation: 'dispose', id });
        } catch {
          close('unavailable');
        }
      });
      return retiring;
    },
  };
}
