import { readRasterMetadata } from './raster-metadata';
import {
  MAX_ENCODED_INPUT_BYTES,
  MAX_ORIGINAL_IMAGE_PIXELS,
  MAX_ORIGINAL_IMAGE_SIDE,
} from '../original-image-limits';
import { isValidImageDimensions } from '../geometry/coordinates';

globalThis.addEventListener(
  'message',
  (event: MessageEvent<{ blob: Blob; options: ImageBitmapOptions }>) => {
    void (async () => {
      const { blob, options } = event.data;
      if (!(blob instanceof Blob) || blob.size > MAX_ENCODED_INPUT_BYTES)
        throw new Error('Invalid HEIF input.');
      const metadata = readRasterMetadata(
        new Uint8Array(await blob.slice(0, 1024 * 1024).arrayBuffer()),
      );
      if (metadata === null || !['image/heic', 'image/heif'].includes(metadata.type))
        throw new Error('Invalid HEIF metadata.');
      const dimensions = metadata.dimensions;
      if (
        !isValidImageDimensions(dimensions) ||
        dimensions.width * dimensions.height > MAX_ORIGINAL_IMAGE_PIXELS ||
        Math.max(dimensions.width, dimensions.height) > MAX_ORIGINAL_IMAGE_SIDE
      )
        throw new Error('HEIF dimensions exceed the original limit.');
      // Self-hosted CSP build selects the unique primary item, never the first image.
      const decoderUrl = new URL(
        '/vendor/heif/decoder-1.6.6-primary-v1.js',
        globalThis.location.origin,
      ).href;
      const { heicTo } = (await import(/* @vite-ignore */ decoderUrl)) as {
        heicTo: (input: {
          blob: Blob;
          type: 'bitmap';
          options: ImageBitmapOptions;
        }) => Promise<ImageBitmap>;
      };
      const bitmap = await heicTo({ blob, type: 'bitmap', options });
      globalThis.postMessage({ bitmap }, { transfer: [bitmap] });
    })().catch(() => {
      globalThis.postMessage({ failed: true });
    });
  },
);
