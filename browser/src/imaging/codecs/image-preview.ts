import type { ImageAsset } from '../../domain/document';

/** A separate display asset, never a replacement for the original or the final render. */
export async function createImagePreview(bitmap: ImageBitmap): Promise<ImageAsset | undefined> {
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const dimensions = {
    width: Math.max(1, Math.round(bitmap.width * scale)),
    height: Math.max(1, Math.round(bitmap.height * scale)),
  };
  const canvas =
    typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(dimensions.width, dimensions.height)
      : document.createElement('canvas');
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  try {
    const context = canvas.getContext('2d');
    if (context === null) return undefined;
    context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);
    const blob =
      'convertToBlob' in canvas
        ? await canvas.convertToBlob({ type: 'image/png' })
        : await new Promise<Blob | null>((resolve) => {
            canvas.toBlob(resolve, 'image/png');
          });
    return blob === null ? undefined : { blob, dimensions };
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}
