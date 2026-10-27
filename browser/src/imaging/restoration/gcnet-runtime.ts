import type { ShadowField } from './shadow-field';
import {
  ShadowRuntimeError,
  SHADOW_FAILURE_CODES,
  type ShadowFailureCode,
} from './shadow-runtime-error';
let worker: Worker | undefined;
let sequence = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let pending:
  | {
      id: number;
      width: number;
      height: number;
      resolve: (field: ShadowField) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  | undefined;
function fail(code: ShadowFailureCode) {
  const active = pending;
  pending = undefined;
  clearTimeout(active?.timer);
  clearTimeout(idleTimer);
  if (worker) {
    worker.onmessage = worker.onerror = worker.onmessageerror = null;
    worker.terminate();
    worker = undefined;
  }
  active?.reject(new ShadowRuntimeError(code));
}
export function disposeShadowRuntime(): void {
  fail('runtime');
}
/** ORT owns its realm, separate from detector ORT and the C++ Emscripten module. */
export function predictIllumination(sample: ShadowField): Promise<ShadowField> {
  if (pending) return Promise.reject(new ShadowRuntimeError('busy'));
  if (
    !Number.isInteger(sample.width) ||
    !Number.isInteger(sample.height) ||
    sample.width < 1 ||
    sample.height < 1 ||
    sample.width > 384 ||
    sample.height > 384 ||
    sample.data.length !== sample.width * sample.height * 3
  )
    return Promise.reject(new ShadowRuntimeError('model-invalid'));
  clearTimeout(idleTimer);
  return new Promise((resolve, reject) => {
    pending = {
      id: ++sequence,
      width: sample.width,
      height: sample.height,
      resolve,
      reject,
      timer: setTimeout(() => {
        fail('timeout');
      }, 60000),
    };
    try {
      if (!worker) {
        worker = new Worker(new URL('./gcnet.worker.ts', import.meta.url), {
          type: 'module',
          name: 'document-shadow',
        });
        worker.onerror = worker.onmessageerror = () => {
          fail('runtime');
        };
        worker.onmessage = (event: MessageEvent) => {
          const reply = event.data as {
            type?: string;
            id?: number;
            field?: ShadowField;
            code?: ShadowFailureCode;
          } | null;
          const active = pending;
          if (!active || reply?.id !== active.id) return;
          if (reply.type === 'error') {
            fail(reply.code && SHADOW_FAILURE_CODES.includes(reply.code) ? reply.code : 'runtime');
            return;
          }
          const field = reply.field;
          if (
            reply.type !== 'result' ||
            field?.width !== active.width ||
            field.height !== active.height ||
            !(field.data instanceof Float32Array) ||
            field.data.length !== active.width * active.height * 3 ||
            field.data.some((v) => !Number.isFinite(v) || v <= 0 || v > 1.5)
          ) {
            fail('model-invalid');
            return;
          }
          pending = undefined;
          clearTimeout(active.timer);
          idleTimer = setTimeout(disposeShadowRuntime, 30000);
          active.resolve(field);
        };
      }
      // Keep the caller sample for material-color analysis after inference.
      const data = sample.data.slice();
      worker.postMessage({ type: 'predict', id: pending.id, sample: { ...sample, data } }, [
        data.buffer,
      ]);
    } catch {
      fail('runtime');
    }
  });
}
