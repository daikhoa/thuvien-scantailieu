import { readRasterMetadata, SUPPORTED_RASTER_TYPES } from '../../imaging/codecs/raster-metadata';
import { decodeRasterBitmap } from '../../imaging/codecs/decode-raster-bitmap';
import { createImagePreview } from '../../imaging/codecs/image-preview';
import type { CropRegion, ImageAsset, ImageDimensions } from '../../domain/document';
import { MAX_ENCODED_INPUT_BYTES } from '../../imaging/codecs/browser-rgba-codec';
import { isValidImageDimensions } from '../../imaging/geometry/coordinates';
import {
  MAX_ORIGINAL_IMAGE_PIXELS,
  MAX_ORIGINAL_IMAGE_SIDE,
} from '../../imaging/original-image-limits';

export type ImageImportFailureCode =
  | 'unsupported-type'
  | 'too-large'
  | 'invalid-file'
  | 'image-too-large'
  | 'decode-failed'
  | 'unavailable';

const SAFE_MESSAGES: Readonly<Record<ImageImportFailureCode, string>> = {
  'unsupported-type': 'The image type is not supported.',
  'too-large': 'The encoded image is too large.',
  'invalid-file': 'The file is not a valid supported image.',
  'image-too-large': 'The decoded image dimensions are too large.',
  'decode-failed': 'The image could not be decoded.',
  unavailable: 'Image decoding is unavailable in this browser.',
};

const HEADER_READ_LIMIT = 1024 * 1024;

export class ImageImportError extends Error {
  override readonly name = 'ImageImportError';

  constructor(readonly code: ImageImportFailureCode) {
    super(SAFE_MESSAGES[code]);
  }
}

export interface ImportedImage {
  readonly original: ImageAsset;
  readonly preview?: ImageAsset;
  /** Present for camera captures: the live guide frozen at shutter time in original axes. */
  readonly captureCrop?: CropRegion;
}

export type ImageImporter = (source: Blob, signal: AbortSignal) => Promise<ImportedImage>;

function abortError(): Error {
  const error = new Error('Image import cancelled.');
  error.name = 'AbortError';
  return error;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function validateDimensions(dimensions: ImageDimensions): void {
  if (!isValidImageDimensions(dimensions)) throw new ImageImportError('invalid-file');
  if (
    Math.max(dimensions.width, dimensions.height) > MAX_ORIGINAL_IMAGE_SIDE ||
    dimensions.width * dimensions.height > MAX_ORIGINAL_IMAGE_PIXELS
  ) {
    throw new ImageImportError('image-too-large');
  }
}

async function readHeader(source: Blob, signal: AbortSignal): Promise<Uint8Array> {
  try {
    const bytes = await source.slice(0, HEADER_READ_LIMIT).arrayBuffer();
    checkAbort(signal);
    return new Uint8Array(bytes);
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (error instanceof ImageImportError) throw error;
    throw new ImageImportError('invalid-file');
  }
}

/** Validates encoded bytes and decoded dimensions without uploading or mutating the source. */
export async function importImage(source: Blob, signal: AbortSignal): Promise<ImportedImage> {
  checkAbort(signal);
  if (!(source instanceof Blob) || source.size <= 0) throw new ImageImportError('invalid-file');
  if (source.size > MAX_ENCODED_INPUT_BYTES) throw new ImageImportError('too-large');
  if (source.type !== '' && !SUPPORTED_RASTER_TYPES.has(source.type)) {
    throw new ImageImportError('unsupported-type');
  }

  const header = await readHeader(source, signal);
  const metadata = readRasterMetadata(header);
  const type = metadata?.type;
  if (
    type === undefined ||
    (source.type !== '' &&
      source.type !== type &&
      !(
        ['image/heic', 'image/heif'].includes(source.type) &&
        ['image/heic', 'image/heif'].includes(type)
      ))
  ) {
    throw new ImageImportError('invalid-file');
  }
  const dimensions = metadata?.dimensions;
  if (dimensions === undefined) throw new ImageImportError('invalid-file');
  validateDimensions(dimensions);
  const normalized = source.type === '' ? source.slice(0, source.size, type) : source;
  if (typeof createImageBitmap !== 'function') throw new ImageImportError('unavailable');

  let decoded: ImageBitmap | null = null;
  try {
    decoded = await decodeRasterBitmap(normalized, { imageOrientation: 'none' }, signal);
    checkAbort(signal);
    const decodedDimensions = { width: decoded.width, height: decoded.height };
    validateDimensions(decodedDimensions);
    const exactMatch =
      decodedDimensions.width === dimensions.width &&
      decodedDimensions.height === dimensions.height;
    const orientationSwap =
      decodedDimensions.width === dimensions.height &&
      decodedDimensions.height === dimensions.width;
    // ISO metadata preflight conservatively uses the largest item, which may be auxiliary.
    // The decoder's primary item dimensions remain authoritative after bounded preflight.
    if (
      !exactMatch &&
      !orientationSwap &&
      !['image/heic', 'image/heif', 'image/avif'].includes(type)
    ) {
      throw new ImageImportError('invalid-file');
    }
    const preview =
      decoded.width * decoded.height > 4_000_000 || ['image/heic', 'image/heif'].includes(type)
        ? await createImagePreview(decoded)
        : undefined;
    checkAbort(signal);
    return {
      ...(preview === undefined ? {} : { preview }),
      original: {
        blob: normalized,
        dimensions: decodedDimensions,
      },
    };
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (error instanceof ImageImportError) throw error;
    throw new ImageImportError('decode-failed');
  } finally {
    decoded?.close();
  }
}
