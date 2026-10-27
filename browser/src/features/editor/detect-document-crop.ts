import type { RgbaBackendInput } from '../../imaging/engines/scanic-backend-contract';
import type { CropRegion, ImageAsset } from '../../domain/document';
import type { ScannerEngine, ScannerFrame } from '../../imaging/contracts/scanner-engine';
import { ScannerEngineError } from '../../imaging/engines/scanner-engine-error';
import { isValidImageDimensions, scaleCorners } from '../../imaging/geometry/coordinates';
import type { ImageAssetFrameSource } from '../scanner/image-asset-frame-source';

function isCancelled(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError')
  );
}

export async function detectDocumentCrop(
  engine: Pick<ScannerEngine, 'detect'>,
  source: ImageAssetFrameSource,
  original: ImageAsset,
  signal: AbortSignal,
  fallback: CropRegion = { kind: 'full-frame' },
  sourcePixels?: RgbaBackendInput,
  preview?: ImageAsset,
): Promise<CropRegion> {
  try {
    let detectionAsset = original;
    if (sourcePixels === undefined && preview !== undefined) {
      const p = preview.dimensions,
        o = original.dimensions;
      // The existing lossless preview shares the original axes. Reject unrelated,
      // oversized or rotated previews; tolerate only resizing's one-pixel rounding.
      if (
        preview.blob.type === 'image/png' &&
        preview.blob.size > 0 &&
        isValidImageDimensions(p) &&
        Math.max(p.width, p.height) <= 1280 &&
        p.width <= o.width &&
        p.height <= o.height &&
        Math.abs(p.width * o.height - p.height * o.width) <= Math.max(o.width, o.height)
      )
        detectionAsset = preview;
    }
    let frame: ScannerFrame;
    try {
      frame = await (sourcePixels === undefined
        ? source.create(detectionAsset, signal)
        : source.create(original, signal, sourcePixels));
    } catch (error) {
      if (detectionAsset === original || isCancelled(error, signal)) throw error;
      frame = await source.create(original, signal);
    }
    try {
      const result = await engine.detect(frame, signal);
      if (
        result.dimensions.width !== frame.dimensions.width ||
        result.dimensions.height !== frame.dimensions.height
      ) {
        throw new ScannerEngineError('failed');
      }
      if (result.kind === 'full-frame') return fallback;
      return {
        kind: 'document',
        corners: scaleCorners(result.corners, result.dimensions, original.dimensions),
      };
    } finally {
      frame.close();
    }
  } catch (error) {
    if (isCancelled(error, signal)) throw error;
    return fallback;
  }
}
