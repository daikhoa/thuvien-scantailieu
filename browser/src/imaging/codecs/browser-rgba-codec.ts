import type { ImageAsset, ImageDimensions } from '../../domain/document';
import type { RgbaBackendInput } from '../engines/scanic-backend-contract';
import { ScannerEngineError } from '../engines/scanner-engine-error';
import { isValidImageDimensions } from '../geometry/coordinates';
import { MAX_WORKING_IMAGE_PIXELS, MAX_WORKING_IMAGE_SIDE } from '../working-image-limits';
import type { RgbaEncodeOptions, RgbaImageCodec } from './rgba-image-codec';
import { SUPPORTED_RASTER_TYPES } from './raster-metadata';
import { decodeRasterBitmap } from './decode-raster-bitmap';
import {
  MAX_ENCODED_INPUT_BYTES,
  MAX_ORIGINAL_IMAGE_PIXELS,
  MAX_ORIGINAL_IMAGE_SIDE,
} from '../original-image-limits';
export { MAX_ENCODED_INPUT_BYTES } from '../original-image-limits';

type RasterSurface = HTMLCanvasElement | OffscreenCanvas;
type RasterContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const SUPPORTED_INPUT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function abortError(): Error {
  const error = new Error('Scanner operation cancelled.');
  error.name = 'AbortError';
  return error;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function validWorkingDimensions(dimensions: ImageDimensions): boolean {
  return (
    isValidImageDimensions(dimensions) &&
    Math.max(dimensions.width, dimensions.height) <= MAX_WORKING_IMAGE_SIDE &&
    dimensions.width * dimensions.height <= MAX_WORKING_IMAGE_PIXELS
  );
}

export function validateRasterAsset(asset: ImageAsset): void {
  if (
    !(asset.blob instanceof Blob) ||
    asset.blob.size <= 0 ||
    asset.blob.size > MAX_ENCODED_INPUT_BYTES ||
    !SUPPORTED_RASTER_TYPES.has(asset.blob.type) ||
    !isValidImageDimensions(asset.dimensions) ||
    Math.max(asset.dimensions.width, asset.dimensions.height) > MAX_ORIGINAL_IMAGE_SIDE ||
    asset.dimensions.width * asset.dimensions.height > MAX_ORIGINAL_IMAGE_PIXELS
  ) {
    throw new ScannerEngineError('invalid-input');
  }
}

function validateRgba(input: RgbaBackendInput): void {
  if (
    !validWorkingDimensions(input.dimensions) ||
    !(input.pixels instanceof Uint8ClampedArray) ||
    !(input.pixels.buffer instanceof ArrayBuffer) ||
    input.pixels.byteLength !== input.dimensions.width * input.dimensions.height * 4
  ) {
    throw new ScannerEngineError('invalid-input');
  }
}

function validateEncodeOptions(options: RgbaEncodeOptions): void {
  if (
    !SUPPORTED_INPUT_TYPES.has(options.type) ||
    (options.quality !== undefined &&
      (!Number.isFinite(options.quality) || options.quality < 0 || options.quality > 1))
  ) {
    throw new ScannerEngineError('invalid-input');
  }
}

function isOffscreenSurface(surface: RasterSurface): surface is OffscreenCanvas {
  return typeof OffscreenCanvas === 'function' && surface instanceof OffscreenCanvas;
}

function createSurface(dimensions: ImageDimensions): RasterSurface {
  if (typeof OffscreenCanvas === 'function') {
    return new OffscreenCanvas(dimensions.width, dimensions.height);
  }
  if (typeof document === 'undefined') throw new ScannerEngineError('unavailable');
  const canvas = document.createElement('canvas');
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  return canvas;
}

function context2d(surface: RasterSurface, readFrequently: boolean): RasterContext {
  const context = surface.getContext('2d', { willReadFrequently: readFrequently });
  if (context === null) throw new ScannerEngineError('unavailable');
  return context;
}

function releaseSurface(surface: RasterSurface | null): void {
  if (surface === null) return;
  surface.width = 1;
  surface.height = 1;
}

function encodedBlob(surface: RasterSurface, options: RgbaEncodeOptions): Promise<Blob | null> {
  if (isOffscreenSurface(surface)) {
    return surface.convertToBlob(
      options.quality === undefined
        ? { type: options.type }
        : { type: options.type, quality: options.quality },
    );
  }
  return new Promise((resolve) => {
    surface.toBlob(resolve, options.type, options.quality);
  });
}

function sanitizedFailure(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) return abortError();
  return error instanceof ScannerEngineError ? error : new ScannerEngineError('failed');
}

export function createBrowserRgbaCodec(): RgbaImageCodec {
  return {
    async decode(asset, signal) {
      checkAbort(signal);
      validateRasterAsset(asset);
      if (!validWorkingDimensions(asset.dimensions)) throw new ScannerEngineError('out-of-memory');
      if (typeof createImageBitmap !== 'function') {
        throw new ScannerEngineError('unavailable');
      }
      let bitmap: ImageBitmap | null = null;
      let surface: RasterSurface | null = null;
      try {
        bitmap = await decodeRasterBitmap(asset.blob, { imageOrientation: 'none' }, signal);
        checkAbort(signal);
        if (bitmap.width !== asset.dimensions.width || bitmap.height !== asset.dimensions.height) {
          throw new ScannerEngineError('invalid-input');
        }
        surface = createSurface(asset.dimensions);
        const context = context2d(surface, true);
        context.drawImage(bitmap, 0, 0);
        checkAbort(signal);
        const image = context.getImageData(0, 0, asset.dimensions.width, asset.dimensions.height);
        checkAbort(signal);
        return {
          dimensions: { ...asset.dimensions },
          pixels: image.data,
        };
      } catch (error) {
        throw sanitizedFailure(error, signal);
      } finally {
        releaseSurface(surface);
        bitmap?.close();
      }
    },

    async encode(input, options, signal) {
      checkAbort(signal);
      validateRgba(input);
      validateEncodeOptions(options);
      let surface: RasterSurface | null = null;
      try {
        surface = createSurface(input.dimensions);
        const context = context2d(surface, false);
        context.putImageData(
          new ImageData(input.pixels, input.dimensions.width, input.dimensions.height),
          0,
          0,
        );
        checkAbort(signal);
        const blob = await encodedBlob(surface, options);
        checkAbort(signal);
        if (blob === null || blob.size <= 0 || blob.type !== options.type) {
          throw new ScannerEngineError('failed');
        }
        return blob;
      } catch (error) {
        throw sanitizedFailure(error, signal);
      } finally {
        releaseSurface(surface);
      }
    },
  };
}
