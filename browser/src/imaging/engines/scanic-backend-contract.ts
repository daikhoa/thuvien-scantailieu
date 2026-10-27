import type { LocalRestorationAnalysis } from '../restoration/local-restoration-client';
import type {
  DocumentCorners,
  FilterMode,
  ImageDimensions,
  ImageAsset,
  QuarterTurn,
  EnhancementFailureCode,
} from '../../domain/document';

export { ScannerEngineError } from './scanner-engine-error';

export interface RgbaBackendInput {
  readonly detectionMode?: 'still';
  readonly enhancementFailure?: EnhancementFailureCode;
  readonly enhancement?: 'local' | 'shadow-model' | 'model-unavailable';
  readonly dimensions: ImageDimensions;
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
  readonly timings?: { readonly warp3000: number; readonly restorationFilter: number };
}

/** Internal adapter seam: no vendor/DOM image types escape the backend. */
export interface RasterWarpRequest {
  readonly asset: ImageAsset;
  readonly corners: DocumentCorners;
  readonly rotation: QuarterTurn;
  readonly filter: FilterMode;
  readonly maximumOutputLongSide?: number;
  readonly analysis?: LocalRestorationAnalysis;
}

export interface ClassicalBackend {
  initialize: () => Promise<void>;
  detect: (input: RgbaBackendInput) => Promise<unknown>;
  warp: (
    input: RgbaBackendInput,
    corners: DocumentCorners,
    rotation: QuarterTurn,
    filter: FilterMode,
    maximumOutputLongSide?: number,
    analysis?: LocalRestorationAnalysis,
  ) => Promise<RgbaBackendInput>;
  warpAsset?: (request: RasterWarpRequest) => Promise<RgbaBackendInput>;
  /** Must settle outstanding work, including termination of its owned worker. */
  dispose: () => Promise<void>;
}
