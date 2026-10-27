import {
  createLocalRestorationClient,
  type LocalRestorationClient,
  type LocalRestorationSource,
} from '../restoration/local-restoration-client';
import { createRgbaThumbnail } from '../rendering/rgba-thumbnail';
import { recordPipelineTiming } from '../pipeline-timing';
import type {
  DocumentCorners,
  FilterMode,
  ImageDimensions,
  Point,
  QuarterTurn,
  RenderedVariant,
} from '../../domain/document';
import { createBrowserRgbaCodec, validateRasterAsset } from '../codecs/browser-rgba-codec';
import type { RgbaImageCodec } from '../codecs/rgba-image-codec';
import type {
  DetectionResult,
  EngineLifecycle,
  RenderPageRequest,
  ScannerEngine,
  ScannerFrame,
} from '../contracts/scanner-engine';
import { isValidImageDimensions } from '../geometry/coordinates';
import { validateQuad } from '../geometry/quad';
import { createRenderRecipeKey } from '../rendering/render-recipe-key';
import { MAX_WORKING_IMAGE_PIXELS, MAX_WORKING_IMAGE_SIDE } from '../working-image-limits';
import { createCompatibleScanicBackend } from './scanic-compatible-backend';
import { type ClassicalBackend, ScannerEngineError } from './scanic-backend-contract';
import { SCANIC_CLASSICAL_MIN_CONFIDENCE, SCANIC_ML_MIN_SCORE } from './scanic-detector-runtime';
import { DOCSCAN_IMPLEMENTATION } from './docscan-assets';
export type { ClassicalBackend, RgbaBackendInput } from './scanic-backend-contract';

export interface ScanicEngineOptions {
  readonly minimumConfidence?: number;
  readonly mlMinimumConfidence?: number;
  readonly createBackend?: () => ClassicalBackend;
  readonly codec?: RgbaImageCodec;
}

const ENGINE_VERSION = `scanic-1.6.0+${DOCSCAN_IMPLEMENTATION}`;
const FILTER_MODES: readonly FilterMode[] = [
  'original',
  'ocr-color',
  'enhanced-color',
  'shadow-removal',
  'grayscale',
  'black-and-white',
];

interface FrameStorage {
  pixels: Uint8ClampedArray<ArrayBuffer> | null;
  borrows: number;
  readonly ownership: 'reusable' | 'single-use';
}

const frames = new WeakMap<ScannerFrame, FrameStorage>();
export function createRgbaScannerFrame(
  dimensions: ImageDimensions,
  pixels: Uint8ClampedArray,
): ScannerFrame {
  return createFrame(dimensions, pixels, 'reusable');
}

/** Consumes newly captured pixels. The frame can be detected once, then must be closed. */
export function createOneShotScannerFrame(
  dimensions: ImageDimensions,
  pixels: Uint8ClampedArray,
  detectionMode?: 'still',
): ScannerFrame {
  return createFrame(dimensions, pixels, 'single-use', detectionMode);
}

function createFrame(
  dimensions: ImageDimensions,
  pixels: Uint8ClampedArray,
  ownership: FrameStorage['ownership'],
  detectionMode?: 'still',
): ScannerFrame {
  if (
    !isValidImageDimensions(dimensions) ||
    Math.max(dimensions.width, dimensions.height) > MAX_WORKING_IMAGE_SIDE ||
    dimensions.width * dimensions.height > MAX_WORKING_IMAGE_PIXELS ||
    pixels.byteLength !== dimensions.width * dimensions.height * 4
  ) {
    throw new ScannerEngineError('invalid-input');
  }
  const ownedPixels = ownership === 'reusable' ? pixels.slice() : pixels;
  if (!(ownedPixels.buffer instanceof ArrayBuffer)) throw new ScannerEngineError('invalid-input');
  const storage: FrameStorage = {
    pixels: ownedPixels as Uint8ClampedArray<ArrayBuffer>,
    borrows: 0,
    ownership,
  };
  const frame: ScannerFrame = Object.freeze({
    ...(detectionMode === undefined ? {} : { detectionMode }),
    dimensions: Object.freeze({
      width: dimensions.width,
      height: dimensions.height,
    }),
    close() {
      if (storage.borrows !== 0) throw new ScannerEngineError('invalid-input');
      storage.pixels = null;
    },
  });
  frames.set(frame, storage);
  return frame;
}

function abortError(): Error {
  // Do not echo a caller's signal.reason (which may carry document data).
  const error = new Error('Scanner operation cancelled.');
  error.name = 'AbortError';
  return error;
}

function checkAbort(signal: AbortSignal, disposal: AbortSignal): void {
  if (signal.aborted || disposal.aborted) throw abortError();
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function point(value: unknown): Point {
  if (
    !record(value) ||
    typeof value.x !== 'number' ||
    typeof value.y !== 'number' ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y)
  ) {
    throw new ScannerEngineError('failed');
  }
  return { x: value.x, y: value.y };
}

function detectionResult(
  output: unknown,
  dimensions: ImageDimensions,
  minimumConfidence: number,
  mlMinimumConfidence: number,
): DetectionResult {
  if (!record(output) || typeof output.success !== 'boolean') {
    throw new ScannerEngineError('failed');
  }
  if (!output.success) {
    const hasBoundedConfidence =
      typeof output.confidence === 'number' &&
      Number.isFinite(output.confidence) &&
      output.confidence >= 0 &&
      output.confidence <= 1;
    if (output.corners !== null || (!hasBoundedConfidence && output.confidence != null)) {
      throw new ScannerEngineError('failed');
    }
    return {
      kind: 'full-frame',
      dimensions,
      reason: hasBoundedConfidence ? 'low-confidence' : 'no-document',
    };
  }
  if (
    typeof output.confidence !== 'number' ||
    !Number.isFinite(output.confidence) ||
    output.confidence < 0 ||
    output.confidence > 1 ||
    !record(output.corners)
  ) {
    throw new ScannerEngineError('failed');
  }
  // Preserve the reported perimeter: sorting would hide corrupted/crossed vendor output.
  const corners: DocumentCorners = [
    point(output.corners.topLeft),
    point(output.corners.topRight),
    point(output.corners.bottomRight),
    point(output.corners.bottomLeft),
  ];
  const geometry = validateQuad(
    corners,
    dimensions,
    Math.max(1, dimensions.width * dimensions.height * 0.02),
  );
  if (!geometry.valid) {
    // ML coordinates are predictions, including on blank/partial/moving documents.
    // Reject an unusable crop without destroying an otherwise healthy ONNX session.
    if (output.detector === 'ml' || geometry.reason === 'area-too-small')
      return { kind: 'full-frame', dimensions, reason: 'low-confidence' };
    throw new ScannerEngineError('failed');
  }
  const [a, b, c] = corners;
  if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) <= 0) {
    if (output.detector === 'ml')
      return { kind: 'full-frame', dimensions, reason: 'low-confidence' };
    throw new ScannerEngineError('failed');
  }
  const detectorMinimum = output.detector === 'ml' ? mlMinimumConfidence : minimumConfidence;
  if (output.confidence < detectorMinimum) {
    return { kind: 'full-frame', dimensions, reason: 'low-confidence' };
  }
  return {
    kind: 'document',
    dimensions,
    corners,
    confidence: output.confidence,
  };
}

function isQuarterTurn(value: number): value is QuarterTurn {
  return value === 0 || value === 90 || value === 180 || value === 270;
}

function renderCorners(request: RenderPageRequest): DocumentCorners {
  const { dimensions } = request.original;
  const sourcePixels = request.sourcePixels;
  validateRasterAsset(request.original);
  if (
    !isValidImageDimensions(dimensions) ||
    !Number.isSafeInteger(request.recipe.version) ||
    request.recipe.version <= 0 ||
    !isQuarterTurn(request.orientation) ||
    !isQuarterTurn(request.recipe.rotation) ||
    request.recipe.filter.presetVersion.length === 0 ||
    request.recipe.filter.presetVersion.length > 128 ||
    Object.keys(request.recipe.filter.parameters).length !== 0 ||
    (request.maximumOutputLongSide !== undefined &&
      (!Number.isSafeInteger(request.maximumOutputLongSide) ||
        request.maximumOutputLongSide <= 0 ||
        request.maximumOutputLongSide > MAX_WORKING_IMAGE_SIDE)) ||
    (sourcePixels !== undefined &&
      (Math.max(dimensions.width, dimensions.height) > MAX_WORKING_IMAGE_SIDE ||
        dimensions.width * dimensions.height > MAX_WORKING_IMAGE_PIXELS ||
        sourcePixels.dimensions.width !== dimensions.width ||
        sourcePixels.dimensions.height !== dimensions.height ||
        !(sourcePixels.pixels instanceof Uint8ClampedArray) ||
        sourcePixels.pixels.byteLength !== dimensions.width * dimensions.height * 4))
  ) {
    throw new ScannerEngineError('invalid-input');
  }
  if (!FILTER_MODES.includes(request.recipe.filter.mode)) {
    throw new ScannerEngineError('invalid-input');
  }
  if (
    request.recipe.dewarp.mode === 'auto' &&
    (request.recipe.dewarp.policyVersion.length === 0 ||
      request.recipe.dewarp.policyVersion.length > 128)
  ) {
    throw new ScannerEngineError('invalid-input');
  }
  const corners: DocumentCorners =
    request.recipe.crop.kind === 'document'
      ? [
          { ...request.recipe.crop.corners[0] },
          { ...request.recipe.crop.corners[1] },
          { ...request.recipe.crop.corners[2] },
          { ...request.recipe.crop.corners[3] },
        ]
      : [
          { x: 0, y: 0 },
          { x: dimensions.width, y: 0 },
          { x: dimensions.width, y: dimensions.height },
          { x: 0, y: dimensions.height },
        ];
  const [topLeft, topRight, bottomRight] = corners;
  const clockwiseTurn =
    (topRight.x - topLeft.x) * (bottomRight.y - topLeft.y) -
    (topRight.y - topLeft.y) * (bottomRight.x - topLeft.x);
  if (!validateQuad(corners, dimensions, 1).valid || clockwiseTurn <= 0) {
    throw new ScannerEngineError('invalid-input');
  }
  return corners;
}

function totalRotation(request: RenderPageRequest): QuarterTurn {
  return ((request.orientation + request.recipe.rotation) % 360) as QuarterTurn;
}

function operationFailure(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) return abortError();
  return error instanceof ScannerEngineError ? error : new ScannerEngineError('failed');
}

class ScanicEngine implements ScannerEngine {
  private state: EngineLifecycle = { kind: 'uninitialized' };
  private backend: ClassicalBackend | null = null;
  private analyzer: LocalRestorationClient | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private readonly disposal = new AbortController();
  private disposalPromise: Promise<void> | null = null;
  private backendDisposal: Promise<void> | null = null;

  constructor(
    private readonly createBackend: () => ClassicalBackend,
    private readonly minimumConfidence: number,
    private readonly mlMinimumConfidence: number,
    private readonly codec: RgbaImageCodec,
  ) {}

  get lifecycle(): EngineLifecycle {
    return this.state;
  }

  private schedule<T>(job: () => Promise<T>): Promise<T> {
    // One running job plus one waiting job; a camera scheduler can drop surplus frames.
    if (this.pending >= 2) return Promise.reject(new ScannerEngineError('unavailable'));
    this.pending++;
    const result = this.tail.then(job).finally(() => {
      this.pending--;
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  private assertReady(signal: AbortSignal): ClassicalBackend {
    checkAbort(signal, this.disposal.signal);
    if (this.state.kind !== 'ready' || this.backend === null) {
      throw new ScannerEngineError('unavailable');
    }
    return this.backend;
  }

  private fail(error: unknown): ScannerEngineError {
    const failure = error instanceof ScannerEngineError ? error : new ScannerEngineError('failed');
    if (!this.disposal.signal.aborted)
      this.state = { kind: 'failed', error: { code: failure.code } };
    return failure;
  }

  private disposeOwnedBackend(): Promise<void> {
    if (this.backendDisposal !== null) return this.backendDisposal;
    const backend = this.backend;
    if (backend === null) return Promise.resolve();
    this.backend = null;
    const cleanup = Promise.resolve()
      .then(() => backend.dispose())
      .then(
        () => {
          if (this.backendDisposal === cleanup) this.backendDisposal = null;
        },
        (error: unknown) => {
          // Retain the rejected promise so later dispose calls cannot report false success.
          throw error;
        },
      );
    this.backendDisposal = cleanup;
    return cleanup;
  }

  private async failBackendOperation(error: unknown, signal: AbortSignal): Promise<never> {
    if (this.disposal.signal.aborted) throw abortError();
    try {
      await this.disposeOwnedBackend();
    } catch (cleanupError) {
      const failure = this.fail(cleanupError);
      checkAbort(signal, this.disposal.signal);
      throw failure;
    }
    const failure = this.fail(error);
    checkAbort(signal, this.disposal.signal);
    throw failure;
  }

  initialize(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.state.kind !== 'uninitialized') {
      return Promise.reject(new ScannerEngineError('unavailable'));
    }
    this.state = { kind: 'initializing' };
    return this.schedule(async () => {
      try {
        checkAbort(signal, this.disposal.signal);
        const backend = this.createBackend();
        this.backend = backend;
        await backend.initialize();
        checkAbort(signal, this.disposal.signal);
        // Scanic.initialize swallows failures. A real scan must work before ready.
        // Use a realistic probe size so either detector can validate its runtime without treating
        // an unsupported tiny input as an engine failure.
        const warmupDimensions = { width: 224, height: 224 };
        const output = await backend.detect({
          dimensions: warmupDimensions,
          pixels: new Uint8ClampedArray(warmupDimensions.width * warmupDimensions.height * 4),
        });
        checkAbort(signal, this.disposal.signal);
        detectionResult(output, warmupDimensions, this.minimumConfidence, this.mlMinimumConfidence);
        this.state = { kind: 'ready' };
      } catch (error) {
        // Dispose owns cleanup once it starts; never call a backend's cleanup twice.
        if (!this.disposal.signal.aborted && this.backend !== null) {
          try {
            await this.disposeOwnedBackend();
          } catch (cleanupError) {
            throw this.fail(cleanupError);
          }
        }
        if (signal.aborted || this.disposal.signal.aborted) {
          if (!this.disposal.signal.aborted) this.state = { kind: 'uninitialized' };
          throw abortError();
        }
        throw this.fail(error);
      }
    });
  }

  detect(frame: ScannerFrame, signal: AbortSignal): Promise<DetectionResult> {
    try {
      this.assertReady(signal);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new ScannerEngineError('failed'));
    }
    return this.schedule(async () => {
      const backend = this.assertReady(signal);
      const storage = frames.get(frame);
      if (storage?.pixels === undefined || storage.pixels === null) {
        throw new ScannerEngineError('invalid-input');
      }
      storage.borrows++;
      try {
        // Fresh live frames transfer directly. Reusable caller frames retain their own copy.
        let output: unknown;
        try {
          const pixels =
            storage.ownership === 'single-use' ? storage.pixels : storage.pixels.slice();
          if (storage.ownership === 'single-use') storage.pixels = null;
          output = await backend.detect({
            dimensions: frame.dimensions,
            ...(frame.detectionMode === undefined ? {} : { detectionMode: frame.detectionMode }),
            pixels,
          });
        } catch (error) {
          return await this.failBackendOperation(error, signal);
        }
        checkAbort(signal, this.disposal.signal);
        try {
          return detectionResult(
            output,
            frame.dimensions,
            this.minimumConfidence,
            this.mlMinimumConfidence,
          );
        } catch (error) {
          return await this.failBackendOperation(error, signal);
        }
      } finally {
        storage.borrows--;
      }
    });
  }

  private async renderPixelsInJob(request: RenderPageRequest, signal: AbortSignal) {
    const backend = this.assertReady(signal);
    let corners: DocumentCorners;
    try {
      corners = renderCorners(request);
    } catch (error) {
      throw operationFailure(error, signal);
    }
    if (request.sourcePixels === undefined && backend.warpAsset !== undefined) {
      try {
        const output = await backend.warpAsset({
          asset: request.original,
          corners,
          rotation: totalRotation(request),
          filter: request.recipe.filter.mode,
          ...(request.maximumOutputLongSide === undefined
            ? {}
            : { maximumOutputLongSide: request.maximumOutputLongSide }),
          ...(request.analysis === undefined ? {} : { analysis: request.analysis }),
        });
        checkAbort(signal, this.disposal.signal);
        return output;
      } catch (error) {
        return await this.failBackendOperation(error, signal);
      }
    }
    let input;
    try {
      input =
        request.sourcePixels === undefined
          ? await this.codec.decode(request.original, signal)
          : {
              dimensions: { ...request.sourcePixels.dimensions },
              pixels: request.consumeSourcePixels
                ? request.sourcePixels.pixels
                : request.sourcePixels.pixels.slice(),
            };
      checkAbort(signal, this.disposal.signal);
    } catch (error) {
      throw operationFailure(error, signal);
    }
    let output;
    try {
      output =
        request.analysis === undefined && request.maximumOutputLongSide === undefined
          ? await backend.warp(input, corners, totalRotation(request), request.recipe.filter.mode)
          : await backend.warp(
              input,
              corners,
              totalRotation(request),
              request.recipe.filter.mode,
              request.maximumOutputLongSide,
              request.analysis,
            );
      checkAbort(signal, this.disposal.signal);
    } catch (error) {
      return await this.failBackendOperation(error, signal);
    }
    return output;
  }

  async analyze(
    source: LocalRestorationSource,
    signal: AbortSignal,
    options?: { readonly analysisKey?: string },
  ) {
    this.assertReady(signal);
    this.analyzer ??= createLocalRestorationClient();
    if (!this.analyzer.analyze) throw new ScannerEngineError('unavailable');
    return this.analyzer.analyze(source, signal, options);
  }

  renderPixels(request: RenderPageRequest, signal: AbortSignal) {
    return this.schedule(() => this.renderPixelsInJob(request, signal));
  }

  render(request: RenderPageRequest, signal: AbortSignal): Promise<RenderedVariant> {
    try {
      this.assertReady(signal);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new ScannerEngineError('failed'));
    }
    return this.schedule(async () => {
      const recipeKey = await createRenderRecipeKey(request, ENGINE_VERSION, signal);
      const output = await this.renderPixelsInJob(request, signal);
      const encodeStarted = performance.now();
      let blob: Blob;
      try {
        blob = await this.codec.encode(output, { type: 'image/jpeg', quality: 0.96 }, signal);
        checkAbort(signal, this.disposal.signal);
      } catch (error) {
        throw operationFailure(error, signal);
      }
      const jpegEncode = performance.now() - encodeStarted;
      let thumbnail;
      if (request.createThumbnail) {
        const preview = createRgbaThumbnail(output, 192);
        thumbnail = {
          dimensions: preview.dimensions,
          blob: await this.codec.encode(preview, { type: 'image/jpeg', quality: 0.8 }, signal),
        };
      }
      recordPipelineTiming({ ...output.timings, jpegEncode });
      return {
        recipeKey:
          output.enhancement === 'model-unavailable' ? recipeKey + ':model-unavailable' : recipeKey,
        ...(output.enhancement ? { enhancement: output.enhancement } : {}),
        ...(output.enhancementFailure ? { enhancementFailure: output.enhancementFailure } : {}),
        engineVersion: ENGINE_VERSION,
        image: { blob, dimensions: { ...output.dimensions } },
        ...(thumbnail === undefined ? {} : { thumbnail }),
        ...(request.preserveOutputPixels ? { transientRgba: output } : {}),
        dewarp:
          request.recipe.dewarp.mode === 'perspective-only'
            ? { kind: 'not-requested' }
            : { kind: 'fallback', reason: 'unavailable' },
      };
    });
  }

  dispose(): Promise<void> {
    if (this.disposalPromise !== null) return this.disposalPromise;
    this.analyzer?.dispose?.();
    this.analyzer = null;
    this.state = { kind: 'disposing' };
    this.disposal.abort();
    // Termination settles in-flight work before waiting for the serialized jobs.
    this.disposalPromise = (async () => {
      try {
        await this.disposeOwnedBackend();
        await this.tail;
        this.backend = null;
        this.state = { kind: 'disposed' };
      } catch {
        const error = new ScannerEngineError('failed');
        this.state = { kind: 'failed', error: { code: error.code } };
        throw error;
      }
    })();
    return this.disposalPromise;
  }
}

export function createScanicEngine(options: ScanicEngineOptions = {}): ScannerEngine {
  // Initial spike policy, not an empirically qualified production threshold.
  const minimumConfidence = options.minimumConfidence ?? SCANIC_CLASSICAL_MIN_CONFIDENCE;
  const mlMinimumConfidence = options.mlMinimumConfidence ?? SCANIC_ML_MIN_SCORE;
  if (
    !Number.isFinite(minimumConfidence) ||
    minimumConfidence < 0 ||
    minimumConfidence > 1 ||
    !Number.isFinite(mlMinimumConfidence) ||
    mlMinimumConfidence < SCANIC_ML_MIN_SCORE ||
    mlMinimumConfidence > 1
  ) {
    throw new ScannerEngineError('invalid-input');
  }
  return new ScanicEngine(
    options.createBackend ?? createCompatibleScanicBackend,
    minimumConfidence,
    mlMinimumConfidence,
    options.codec ?? createBrowserRgbaCodec(),
  );
}

/** Internal compatibility alias; production callers use createScanicEngine. */
export const createScanicClassicalEngine = createScanicEngine;
