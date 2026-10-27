import type { DocumentCorners, FilterMode, ImageAsset, QuarterTurn } from '../../domain/document';
import type { LocalRestorationAnalysis } from '../restoration/local-restoration-client';
import { validateRasterAsset } from '../codecs/browser-rgba-codec';
import { decodeRasterBitmap } from '../codecs/decode-raster-bitmap';
import { ScannerEngineError } from './scanner-engine-error';
import { renderDocscanRegions } from './docscan-raster';

/** Retain one native bitmap; C++ requests only the original-resolution pixels it needs. */
export async function renderDocscanAsset(
  asset: ImageAsset,
  corners: DocumentCorners,
  filter: FilterMode,
  rotation: QuarterTurn,
  maximum?: number,
  analysis?: LocalRestorationAnalysis,
) {
  validateRasterAsset(asset);
  let bitmap: ImageBitmap | null = null;
  let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  const releaseSource = () => {
    bitmap?.close();
    bitmap = null;
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  };
  try {
    const started = performance.now();
    bitmap = await decodeRasterBitmap(asset.blob, { imageOrientation: 'none' });
    if (bitmap.width !== asset.dimensions.width || bitmap.height !== asset.dimensions.height)
      throw new ScannerEngineError('invalid-input');
    canvas =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(1, 1)
        : document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true }) as
      OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!context) throw new ScannerEngineError('unavailable');
    const surface = canvas,
      source = bitmap;
    const decoded = performance.now();
    const result = await renderDocscanRegions(
      asset.dimensions,
      corners,
      (region) => {
        surface.width = region.width;
        surface.height = region.height;
        context.drawImage(
          source,
          region.x,
          region.y,
          region.width,
          region.height,
          0,
          0,
          region.width,
          region.height,
        );
        return {
          dimensions: region,
          pixels: context.getImageData(0, 0, region.width, region.height).data,
        };
      },
      filter,
      rotation,
      maximum,
      analysis,
      releaseSource,
    );
    return { ...result, decodeMs: decoded - started };
  } finally {
    releaseSource();
  }
}
