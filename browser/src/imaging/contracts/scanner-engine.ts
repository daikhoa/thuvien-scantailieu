import type {
  LocalRestorationSource,
  LocalRestorationAnalysis,
} from '../restoration/local-restoration-client';
import type { RgbaBackendInput } from '../engines/scanic-backend-contract';
import type {
  DocumentCorners,
  EditRecipe,
  ImageAsset,
  ImageDimensions,
  ProcessingFailure,
  QuarterTurn,
  RenderedVariant,
} from '../../domain/document';

export type EngineFailure = ProcessingFailure;

export type EngineLifecycle =
  | { readonly kind: 'uninitialized' }
  | { readonly kind: 'initializing' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'failed'; readonly error: EngineFailure }
  | { readonly kind: 'disposing' }
  | { readonly kind: 'disposed' };

/**
 * Opaque handle produced by the engine's frame adapter. Pixel storage stays private to that
 * adapter (for example an ImageBitmap or transferable buffer). The caller owns the handle
 * and must close it in finally after detect settles, including failure or cancellation.
 */
export interface ScannerFrame {
  readonly detectionMode?: 'still';
  readonly dimensions: ImageDimensions;
  /** Idempotent; releases backing bitmap/buffer resources. Never close while borrowed. */
  close(): void;
}

/** Detection corners use this input frame's coordinates, never implicitly original pixels. */
export type DetectionResult =
  | {
      readonly kind: 'document';
      readonly dimensions: ImageDimensions;
      readonly corners: DocumentCorners;
      readonly confidence: number;
    }
  | {
      readonly kind: 'full-frame';
      readonly dimensions: ImageDimensions;
      readonly reason: 'no-document' | 'low-confidence';
    };

export interface RenderPageRequest {
  readonly original: ImageAsset;
  /** Optional captured pixels avoid re-decoding the newly encoded durable original. */
  readonly sourcePixels?: {
    readonly dimensions: ImageDimensions;
    readonly pixels: Uint8ClampedArray<ArrayBuffer>;
  };
  /**
   * Clockwise correction for the stored original. Render first crops/corrects geometry in
   * stored-image axes, then applies this orientation, then recipe.rotation clockwise.
   * The total post-geometry turn is (orientation + recipe.rotation) modulo 360.
   */
  readonly orientation: QuarterTurn;
  readonly recipe: EditRecipe;
  /** Optional long-side cap for fast rough/preview renders. Omit for the 3000 px final. */
  readonly maximumOutputLongSide?: number;
  /** Keeps rendered pixels for one zero-copy handoff to the local restoration worker. */
  readonly preserveOutputPixels?: boolean;
  readonly analysis?: LocalRestorationAnalysis;
  readonly createThumbnail?: boolean;
  /** Transfers captured storage only after its durable original has been saved. */
  readonly consumeSourcePixels?: boolean;
}

/**
 * Adapters serialize work and accept detect/render only while ready. Initialize starts from
 * uninitialized; a disposed instance cannot be reused. Aborted signals reject
 * with AbortError, including signals already aborted at entry. No partial result is success.
 * Engine-internal canvases, temporary bitmaps and WASM resources must be released on every
 * path; inputs are borrowed and must not be mutated, closed or transferred away from callers.
 */
export interface ScannerEngine {
  readonly lifecycle: EngineLifecycle;
  initialize(signal: AbortSignal): Promise<void>;
  detect(frame: ScannerFrame, signal: AbortSignal): Promise<DetectionResult>;
  /** Returned blobs belong to the caller; any object URLs it creates must be revoked by it. */
  render(request: RenderPageRequest, signal: AbortSignal): Promise<RenderedVariant>;
  /** Unencoded rough crop for analysis; production adapters implement this path. */
  analyze?(
    source: LocalRestorationSource,
    signal: AbortSignal,
    options?: { readonly analysisKey?: string },
  ): Promise<LocalRestorationAnalysis>;
  renderPixels?(request: RenderPageRequest, signal: AbortSignal): Promise<RgbaBackendInput>;
  /** Idempotently cancel/settle in-flight jobs and free engine resources; cleanup cannot abort. */
  dispose(): Promise<void>;
}
