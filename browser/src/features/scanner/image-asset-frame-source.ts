import type { RgbaBackendInput } from '../../imaging/engines/scanic-backend-contract';
import type { ImageAsset } from '../../domain/document';
import { validateRasterAsset } from '../../imaging/codecs/browser-rgba-codec';
import type { ScannerFrame } from '../../imaging/contracts/scanner-engine';
import { createOneShotScannerFrame } from '../../imaging/engines/scanic-classical-engine';
import { decodeRasterBitmap } from '../../imaging/codecs/decode-raster-bitmap';
import { ScannerEngineError } from '../../imaging/engines/scanner-engine-error';
import { MAX_WORKING_IMAGE_SIDE } from '../../imaging/working-image-limits';

const DEFAULT_MAX_SIDE = 960;

interface ImageAssetFrameSourceOptions {
  readonly maxSide?: number;
  readonly createImageBitmap?: (blob: Blob, options?: ImageBitmapOptions) => Promise<ImageBitmap>;
  readonly createCanvas?: () => HTMLCanvasElement;
}

export interface ImageAssetFrameSource {
  create(
    asset: ImageAsset,
    signal: AbortSignal,
    sourcePixels?: RgbaBackendInput,
  ): Promise<ScannerFrame>;
}

function abortError(): Error {
  const error = new Error('Image detection cancelled.');
  error.name = 'AbortError';
  return error;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function browserDecoder(blob: Blob, options?: ImageBitmapOptions): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== 'function') {
    return Promise.reject(new ScannerEngineError('unavailable'));
  }
  return decodeRasterBitmap(blob, options);
}

function browserCanvas(): HTMLCanvasElement {
  if (typeof document === 'undefined') throw new ScannerEngineError('unavailable');
  return document.createElement('canvas');
}

export function createImageAssetFrameSource(
  options: ImageAssetFrameSourceOptions = {},
): ImageAssetFrameSource {
  const maxSide = options.maxSide ?? DEFAULT_MAX_SIDE;
  if (!Number.isSafeInteger(maxSide) || maxSide < 1 || maxSide > MAX_WORKING_IMAGE_SIDE) {
    throw new RangeError('Invalid image detection maximum side.');
  }
  const decode = options.createImageBitmap ?? browserDecoder;
  const createCanvas = options.createCanvas ?? browserCanvas;

  return {
    async create(asset, signal, sourcePixels) {
      checkAbort(signal);
      validateRasterAsset(asset);
      let bitmap: ImageBitmap | null = null;
      let canvas: HTMLCanvasElement | null = null;
      try {
        bitmap =
          sourcePixels === undefined
            ? await decode(asset.blob, { imageOrientation: 'none' })
            : await createImageBitmap(
                new ImageData(
                  sourcePixels.pixels,
                  sourcePixels.dimensions.width,
                  sourcePixels.dimensions.height,
                ),
              );
        checkAbort(signal);
        if (bitmap.width !== asset.dimensions.width || bitmap.height !== asset.dimensions.height) {
          throw new ScannerEngineError('invalid-input');
        }
        const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
        const dimensions = {
          width: Math.max(1, Math.round(bitmap.width * scale)),
          height: Math.max(1, Math.round(bitmap.height * scale)),
        };
        canvas = createCanvas();
        canvas.width = dimensions.width;
        canvas.height = dimensions.height;
        const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
        if (context === null) throw new ScannerEngineError('unavailable');
        context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);
        checkAbort(signal);
        const pixels = context.getImageData(0, 0, dimensions.width, dimensions.height).data;
        checkAbort(signal);
        return createOneShotScannerFrame(dimensions, pixels, 'still');
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (error instanceof ScannerEngineError) throw error;
        throw new ScannerEngineError('failed');
      } finally {
        bitmap?.close();
        if (canvas !== null) {
          canvas.width = 1;
          canvas.height = 1;
        }
      }
    },
  };
}
