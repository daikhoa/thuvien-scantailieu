import type { ClassicalBackend } from './scanic-backend-contract';
import { ScannerEngineError } from './scanner-engine-error';
import { createScanicWorkerBackend } from './scanic-worker-backend';

interface CompatibleBackendOptions {
  readonly createWorker?: () => ClassicalBackend;
  readonly createFallback?: () => Promise<ClassicalBackend>;
}

async function loadMainThreadFallback(): Promise<ClassicalBackend> {
  const module = await import('./scanic-main-thread-backend');
  return module.createScanicMainThreadBackend();
}

/** Try one owned DOM realm if worker bootstrap cannot run the ML model on this browser. */
export function createCompatibleScanicBackend(
  options: CompatibleBackendOptions = {},
): ClassicalBackend {
  const createWorker = options.createWorker ?? createScanicWorkerBackend;
  const createFallback = options.createFallback ?? loadMainThreadFallback;
  let active: ClassicalBackend | null = null;
  let initialized = false;
  let initializing = false;
  let disposed = false;
  let usingWorker = true;
  let workerVerified = false;
  const cleanup = new WeakMap<ClassicalBackend, Promise<void>>();
  const isDisposed = () => disposed;
  const release = (backend: ClassicalBackend): Promise<void> => {
    if (active === backend) active = null;
    let task = cleanup.get(backend);
    if (task === undefined) {
      task = Promise.resolve().then(() => backend.dispose());
      cleanup.set(backend, task);
    }
    return task;
  };
  const activate = async (candidate: ClassicalBackend): Promise<void> => {
    if (isDisposed()) {
      await release(candidate);
      throw new ScannerEngineError('unavailable');
    }
    active = candidate;
    try {
      await candidate.initialize();
      if (isDisposed()) throw new ScannerEngineError('unavailable');
      initialized = true;
    } catch (error) {
      await release(candidate);
      throw error;
    }
  };
  const requireActive = (): ClassicalBackend => {
    if (disposed || !initialized || active === null) throw new ScannerEngineError('unavailable');
    return active;
  };
  return {
    async initialize() {
      if (disposed || initialized || initializing) throw new ScannerEngineError('unavailable');
      initializing = true;
      try {
        try {
          await activate(createWorker());
        } catch (error) {
          if (isDisposed()) throw error;
          usingWorker = false;
          await activate(await createFallback());
        }
      } finally {
        initializing = false;
      }
    },
    async detect(input) {
      const current = requireActive();
      // Retain only the reduced detection frame for one retry; warp never makes this copy.
      const retryInput = { ...input, pixels: input.pixels.slice() };
      try {
        const output = await current.detect(input);
        if (usingWorker) workerVerified = true;
        return output;
      } catch (error) {
        if (isDisposed()) throw error;
        initialized = false;
        await release(current);
        if (isDisposed()) throw new ScannerEngineError('unavailable');
        // Scanner.initialize() swallows vendor errors. Its first real inference is the
        // bootstrap check; recreating an incompatible worker cannot repair that failure.
        if (usingWorker && !workerVerified) usingWorker = false;
        const recovered = usingWorker ? createWorker() : await createFallback();
        try {
          await activate(recovered);
          return await recovered.detect(retryInput);
        } catch (retryError) {
          initialized = false;
          await release(recovered);
          throw retryError;
        }
      }
    },
    warp(input, corners, rotation, filter, maximumOutputLongSide, analysis) {
      return requireActive().warp(
        input,
        corners,
        rotation,
        filter,
        maximumOutputLongSide,
        analysis,
      );
    },
    warpAsset(request) {
      const current = requireActive();
      if (current.warpAsset === undefined)
        return Promise.reject(new ScannerEngineError('unavailable'));
      return current.warpAsset(request);
    },
    async dispose() {
      disposed = true;
      initialized = false;
      const current = active;
      if (current !== null) await release(current);
    },
  };
}
