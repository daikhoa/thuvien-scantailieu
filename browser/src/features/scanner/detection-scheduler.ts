import type {
  DocumentCorners,
  ImageDimensions,
  Point,
  ProcessingFailure,
} from '../../domain/document';
import type {
  DetectionResult,
  ScannerEngine,
  ScannerFrame,
} from '../../imaging/contracts/scanner-engine';

export type DetectionEngine = Pick<ScannerEngine, 'detect'>;

export type LiveDetectionResult =
  | Extract<DetectionResult, { readonly kind: 'document' }>
  | Extract<DetectionResult, { readonly kind: 'full-frame' }>
  | {
      readonly kind: 'full-frame';
      readonly dimensions: ImageDimensions;
      readonly reason: 'unstable-document';
    };

export interface DetectionSmoother {
  update(result: DetectionResult): LiveDetectionResult;
  reset(): void;
}

export interface DetectionSmootherOptions {
  readonly stableFrames?: number;
  readonly missTolerance?: number;
  readonly maxCornerDriftRatio?: number;
  readonly smoothingAlpha?: number;
}

export interface DetectionScheduler {
  /** Check before allocating/readback of the next live camera frame. */
  readonly canAcceptFrame: boolean;
  /** Transfers ownership of the frame to the scheduler, including when already disposed. */
  submit(frame: ScannerFrame): void;
  /** Idempotently cancels work and settles after every owned frame has been released. */
  dispose(): Promise<void>;
}

export interface DetectionSchedulerOptions extends DetectionSmootherOptions {
  readonly engine: DetectionEngine;
  readonly onResult: (result: LiveDetectionResult) => void;
  readonly onError?: (error: ProcessingFailure) => void;
  /** Minimum delay between detection starts. Defaults to 125 ms (8 Hz). */
  readonly intervalMs?: number;
}

export type DetectionSchedulerConfiguration = DetectionSmootherOptions & {
  readonly intervalMs?: number;
};

const DEFAULT_STABLE_FRAMES = 3;
const DEFAULT_MISS_TOLERANCE = 1;
const DEFAULT_MAX_CORNER_DRIFT_RATIO = 0.03;
const DEFAULT_SMOOTHING_ALPHA = 0.5;
const DEFAULT_INTERVAL_MS = 125;
const FAILURE_CODES = new Set<ProcessingFailure['code']>([
  'unavailable',
  'timeout',
  'out-of-memory',
  'invalid-input',
  'failed',
]);

function sameDimensions(left: ImageDimensions, right: ImageDimensions): boolean {
  return left.width === right.width && left.height === right.height;
}

function blendPoint(previous: Point, current: Point, alpha: number): Point {
  return {
    x: previous.x + (current.x - previous.x) * alpha,
    y: previous.y + (current.y - previous.y) * alpha,
  };
}

function blendCorners(
  previous: DocumentCorners,
  current: DocumentCorners,
  alpha: number,
): DocumentCorners {
  return [
    blendPoint(previous[0], current[0], alpha),
    blendPoint(previous[1], current[1], alpha),
    blendPoint(previous[2], current[2], alpha),
    blendPoint(previous[3], current[3], alpha),
  ];
}

function maximumCornerDrift(
  previous: DocumentCorners,
  current: DocumentCorners,
  dimensions: ImageDimensions,
): number {
  const diagonal = Math.hypot(dimensions.width, dimensions.height);
  const drift = (index: 0 | 1 | 2 | 3) =>
    Math.hypot(current[index].x - previous[index].x, current[index].y - previous[index].y) /
    diagonal;
  return Math.max(drift(0), drift(1), drift(2), drift(3));
}

function validSmootherOptions(options: Required<DetectionSmootherOptions>): void {
  if (
    !Number.isSafeInteger(options.stableFrames) ||
    options.stableFrames < 1 ||
    !Number.isSafeInteger(options.missTolerance) ||
    options.missTolerance < 0 ||
    !Number.isFinite(options.maxCornerDriftRatio) ||
    options.maxCornerDriftRatio <= 0 ||
    options.maxCornerDriftRatio > 1 ||
    !Number.isFinite(options.smoothingAlpha) ||
    options.smoothingAlpha <= 0 ||
    options.smoothingAlpha > 1
  ) {
    throw new RangeError('Invalid detection smoothing options.');
  }
}

export function createDetectionSmoother(partial: DetectionSmootherOptions = {}): DetectionSmoother {
  const options: Required<DetectionSmootherOptions> = {
    stableFrames: partial.stableFrames ?? DEFAULT_STABLE_FRAMES,
    missTolerance: partial.missTolerance ?? DEFAULT_MISS_TOLERANCE,
    maxCornerDriftRatio: partial.maxCornerDriftRatio ?? DEFAULT_MAX_CORNER_DRIFT_RATIO,
    smoothingAlpha: partial.smoothingAlpha ?? DEFAULT_SMOOTHING_ALPHA,
  };
  validSmootherOptions(options);

  let candidate:
    | {
        dimensions: ImageDimensions;
        corners: DocumentCorners;
        confidence: number;
        count: number;
        misses: number;
        locked: boolean;
        minimumConfidence: number;
      }
    | undefined;

  const reset = () => {
    candidate = undefined;
  };

  return {
    reset,
    update(result) {
      if (result.kind === 'full-frame') {
        if (
          candidate !== undefined &&
          candidate.locked &&
          sameDimensions(candidate.dimensions, result.dimensions) &&
          candidate.misses < options.missTolerance
        ) {
          candidate = { ...candidate, misses: candidate.misses + 1 };
          return {
            kind: 'document',
            dimensions: candidate.dimensions,
            corners: candidate.corners,
            confidence: candidate.confidence,
          };
        }
        reset();
        return result;
      }

      if (
        candidate === undefined ||
        !sameDimensions(candidate.dimensions, result.dimensions) ||
        maximumCornerDrift(candidate.corners, result.corners, result.dimensions) >
          options.maxCornerDriftRatio
      ) {
        candidate = {
          dimensions: { ...result.dimensions },
          corners: result.corners.map((corner) => ({ ...corner })) as unknown as DocumentCorners,
          confidence: result.confidence,
          count: 1,
          misses: 0,
          locked: false,
          minimumConfidence: result.confidence,
        };
      } else {
        candidate = {
          dimensions: candidate.dimensions,
          corners: blendCorners(candidate.corners, result.corners, options.smoothingAlpha),
          confidence:
            candidate.confidence +
            (result.confidence - candidate.confidence) * options.smoothingAlpha,
          count: candidate.count + 1,
          misses: 0,
          locked: candidate.locked,
          minimumConfidence: Math.min(candidate.minimumConfidence, result.confidence),
        };
      }

      const requiredFrames =
        partial.stableFrames === undefined && candidate.minimumConfidence >= 0.85
          ? 2
          : options.stableFrames;
      if (!candidate.locked && candidate.count < requiredFrames) {
        return {
          kind: 'full-frame',
          dimensions: result.dimensions,
          reason: 'unstable-document',
        };
      }
      candidate.locked = true;
      return {
        kind: 'document',
        dimensions: candidate.dimensions,
        corners: candidate.corners,
        confidence: candidate.confidence,
      };
    },
  };
}

export function validateDetectionSchedulerConfiguration(
  options: DetectionSchedulerConfiguration,
): void {
  createDetectionSmoother(options);
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > 60_000) {
    throw new RangeError('Invalid detection interval.');
  }
}

function abortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function safeFailure(error: unknown): ProcessingFailure {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    FAILURE_CODES.has(error.code as ProcessingFailure['code'])
  ) {
    return { code: error.code as ProcessingFailure['code'] };
  }
  return { code: 'failed' };
}

export function createDetectionScheduler(options: DetectionSchedulerOptions): DetectionScheduler {
  validateDetectionSchedulerConfiguration(options);
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const smoother = createDetectionSmoother(options);
  const lifecycle = { disposed: false };
  let pending: ScannerFrame | null = null;
  let active:
    | {
        readonly controller: AbortController;
        readonly task: Promise<void>;
      }
    | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextStartAt = 0;
  let disposal: Promise<void> | undefined;

  const closeFrame = (frame: ScannerFrame): ProcessingFailure | undefined => {
    try {
      frame.close();
      return undefined;
    } catch {
      return { code: 'failed' };
    }
  };

  const pump = () => {
    if (lifecycle.disposed || active !== undefined || pending === null || timer !== undefined) {
      return;
    }
    const delay = Math.max(0, nextStartAt - Date.now());
    if (delay > 0) {
      timer = setTimeout(() => {
        timer = undefined;
        pump();
      }, delay);
      return;
    }

    const frame = pending;
    pending = null;
    const controller = new AbortController();
    nextStartAt = Date.now() + intervalMs;
    const task = (async () => {
      let result: DetectionResult | undefined;
      let failure: ProcessingFailure | undefined;
      try {
        result = await options.engine.detect(frame, controller.signal);
      } catch (error) {
        if (!abortError(error)) failure = safeFailure(error);
      }
      const closeFailure = closeFrame(frame);
      failure ??= closeFailure;
      active = undefined;

      if (!lifecycle.disposed) {
        if (failure !== undefined) options.onError?.(failure);
        else if (result !== undefined) options.onResult(smoother.update(result));
        pump();
      }
    })();
    active = { controller, task };
  };

  return {
    get canAcceptFrame() {
      return !lifecycle.disposed && active === undefined && pending === null && timer === undefined;
    },
    submit(frame) {
      if (lifecycle.disposed) {
        closeFrame(frame);
        return;
      }
      const replaced = pending;
      pending = frame;
      if (replaced !== null) {
        const failure = closeFrame(replaced);
        if (failure !== undefined) options.onError?.(failure);
      }
      pump();
    },
    dispose() {
      if (disposal !== undefined) return disposal;
      lifecycle.disposed = true;
      smoother.reset();
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (pending !== null) {
        closeFrame(pending);
        pending = null;
      }
      const running = active;
      running?.controller.abort();
      disposal = running?.task ?? Promise.resolve();
      return disposal;
    },
  };
}
