function abortError() {
  const error = new Error('Image decoding cancelled.');
  error.name = 'AbortError';
  return error;
}

async function decodeHeic(
  blob: Blob,
  options: ImageBitmapOptions,
  signal?: AbortSignal,
): Promise<ImageBitmap> {
  // A decoder worker is temporary: its asm.js heap is released after each fallback decode.
  // This also avoids retaining a decoder heap in the main UI or scanner worker.
  if (typeof Worker !== 'function') {
    throw new Error('HEIF decoder requires worker support.');
  }
  const worker = new Worker(new URL('./heic-decoder.worker.ts', import.meta.url), {
    type: 'module',
    name: 'local-heif-decode',
  });
  return await new Promise<ImageBitmap>((resolve, reject) => {
    let finished = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
    };
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    };
    const abort = () => {
      fail(abortError());
    };
    const timer = setTimeout(() => {
      fail(new Error('Image decoding timed out.'));
    }, 30000);
    worker.onmessage = (event: MessageEvent<{ bitmap?: ImageBitmap }>) => {
      const bitmap = event.data.bitmap;
      if (finished) {
        bitmap?.close();
        return;
      }
      if (bitmap === undefined) {
        fail(new Error('HEIF decoding failed.'));
        return;
      }
      finished = true;
      cleanup();
      resolve(bitmap);
    };
    worker.onerror = () => {
      fail(new Error('HEIF decoder unavailable.'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    try {
      worker.postMessage({ blob, options });
    } catch {
      fail(new Error('HEIF decoder unavailable.'));
    }
  });
}

/** Prefer the browser decoder; load the HEIF codec only when native HEIF decoding fails. */
export async function decodeRasterBitmap(
  blob: Blob,
  options: ImageBitmapOptions = { imageOrientation: 'none' },
  signal?: AbortSignal,
): Promise<ImageBitmap> {
  if (signal?.aborted) throw abortError();
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, options);
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (!['image/heic', 'image/heif'].includes(blob.type)) throw error;
    bitmap = await decodeHeic(blob, options, signal);
  }
  if (signal?.aborted) {
    bitmap.close();
    throw abortError();
  }
  return bitmap;
}
