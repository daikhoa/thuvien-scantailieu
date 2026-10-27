/** Continuous image-edge coordinates: x ∈ [0, width], y ∈ [0, height]. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

/** Clockwise TL, TR, BR, BL in the containing contract's image space; never unordered. */
export type DocumentCorners = readonly [Point, Point, Point, Point];
export type QuarterTurn = 0 | 90 | 180 | 270;

export interface ProcessingFailure {
  /** Stable classification safe for display; never raw library errors or document content. */
  readonly code: 'unavailable' | 'timeout' | 'out-of-memory' | 'invalid-input' | 'failed';
}

export interface Document {
  readonly id: string;
  readonly name: string;
  /** UTC instants encoded as ISO 8601 strings for persistence. */
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pageIds: readonly string[];
}

export interface ImageAsset {
  /** Immutable encoded bytes, shared by reference; release references to permit collection. */
  readonly blob: Blob;
  readonly dimensions: ImageDimensions;
}

export type CropRegion =
  | { readonly kind: 'full-frame' }
  /** Recipe crop points always use the original stored image's axes and dimensions. */
  | { readonly kind: 'document'; readonly corners: DocumentCorners };

export type FilterMode =
  'original' | 'ocr-color' | 'enhanced-color' | 'shadow-removal' | 'grayscale' | 'black-and-white';

export interface EditRecipe {
  readonly version: number;
  readonly crop: CropRegion;
  /** Clockwise user rotation after crop/geometry correction and original orientation. */
  readonly rotation: QuarterTurn;
  readonly dewarp:
    | { readonly mode: 'perspective-only' }
    | { readonly mode: 'auto'; readonly policyVersion: string };
  readonly filter: {
    readonly mode: FilterMode;
    readonly presetVersion: string;
    readonly parameters: Readonly<Record<string, number>>;
  };
}

export type DewarpOutcome =
  | { readonly kind: 'not-requested' }
  | { readonly kind: 'not-needed' }
  | { readonly kind: 'applied'; readonly modelVersion: string }
  | {
      readonly kind: 'fallback';
      readonly reason: 'unavailable' | 'timeout' | 'out-of-memory' | 'failed';
    };

export type EnhancementFailureCode =
  'download' | 'model-invalid' | 'memory' | 'runtime' | 'inference' | 'timeout' | 'busy';

export interface RenderedVariant {
  readonly enhancementFailure?: EnhancementFailureCode;
  readonly enhancement?: 'local' | 'shadow-model' | 'model-unavailable';
  /** Scoped to the immutable original; covers recipe, original orientation and engine version. */
  readonly recipeKey: string;
  readonly engineVersion: string;
  readonly image: ImageAsset;
  readonly thumbnail?: ImageAsset;
  readonly dewarp: DewarpOutcome;
  /** Ephemeral worker handoff; consumers must drop it after local restoration starts. */
  readonly transientRgba?: {
    readonly dimensions: ImageDimensions;
    readonly pixels: Uint8ClampedArray<ArrayBuffer>;
  };
}

export type PageProcessingState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'processing'; readonly operationId: string }
  | { readonly kind: 'ready'; readonly variant: RenderedVariant }
  | { readonly kind: 'failed'; readonly error: ProcessingFailure };

export interface PageAsset {
  readonly id: string;
  /** The original is never replaced by a rendered variant; it is the durable source. */
  readonly original: ImageAsset;
  readonly thumbnail: ImageAsset | null;
  /** Rotation needed to display the original upright; recipe corners use stored image axes. */
  readonly orientation: QuarterTurn;
  readonly recipe: EditRecipe;
  readonly processing: PageProcessingState;
}
