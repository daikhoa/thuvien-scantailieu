import { isValidImageDimensions } from '../../imaging/geometry/coordinates';
import { createRgbaThumbnail } from '../../imaging/rendering/rgba-thumbnail';
import type { RgbaBackendInput } from '../../imaging/engines/scanic-backend-contract';
import {
  MAX_WORKING_IMAGE_PIXELS,
  MAX_WORKING_IMAGE_SIDE,
} from '../../imaging/working-image-limits';

export type CameraCaptureFailureCode = 'unavailable' | 'invalid-input' | 'failed';

const SAFE_MESSAGES: Readonly<Record<CameraCaptureFailureCode, string>> = {
  unavailable: 'Camera capture is unavailable.',
  'invalid-input': 'Camera frame dimensions are invalid.',
  failed: 'Camera capture failed.',
};
const HAVE_CURRENT_DATA = 2;

export class CameraCaptureError extends Error {
  override readonly name = 'CameraCaptureError';

  constructor(readonly code: CameraCaptureFailureCode) {
    super(SAFE_MESSAGES[code]);
  }
}

interface CameraCaptureOptions {
  readonly createCanvas?: () => HTMLCanvasElement;
}

export interface CameraCapture {
  capture(
    stream: MediaStream,
    video: HTMLVideoElement,
    signal: AbortSignal,
  ): Promise<CapturedRgbaFrame | Blob>;
}

export interface CapturedRgbaFrame {
  readonly kind: 'rgba-frame';
  readonly dimensions: { readonly width: number; readonly height: number };
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
  readonly captureMs?: number;
  readonly preview?: RgbaBackendInput;
}

function abortError(): Error {
  const error = new Error('Camera capture cancelled.');
  error.name = 'AbortError';
  return error;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function browserCanvas(): HTMLCanvasElement {
  if (typeof document === 'undefined') throw new CameraCaptureError('unavailable');
  return document.createElement('canvas');
}

function validDimensions(width: number, height: number): boolean {
  const dimensions = { width, height };
  return (
    isValidImageDimensions(dimensions) &&
    Math.max(width, height) <= MAX_WORKING_IMAGE_SIDE &&
    width * height <= MAX_WORKING_IMAGE_PIXELS
  );
}

export function createCameraCapture(options: CameraCaptureOptions = {}): CameraCapture {
  const createCanvas = options.createCanvas ?? browserCanvas;

  return {
    capture(_stream, video, signal) {
      const started = performance.now();
      let canvas: HTMLCanvasElement | null = null;
      try {
        checkAbort(signal);
        if (
          video.readyState < HAVE_CURRENT_DATA ||
          !validDimensions(video.videoWidth, video.videoHeight)
        ) {
          throw new CameraCaptureError('invalid-input');
        }
        canvas = createCanvas();
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d', { alpha: false });
        if (context === null) throw new CameraCaptureError('unavailable');

        // Freeze the current high-resolution preview synchronously at the shutter press. ImageData
        // already owns its ArrayBuffer, so hand that buffer to the pipeline instead of cloning a
        // second full-resolution RGBA allocation.
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        checkAbort(signal);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        checkAbort(signal);
        return Promise.resolve({
          kind: 'rgba-frame',
          dimensions: { width: canvas.width, height: canvas.height },
          pixels: image.data,
          preview: createRgbaThumbnail(
            { dimensions: { width: canvas.width, height: canvas.height }, pixels: image.data },
            128,
          ),
          captureMs: performance.now() - started,
        });
      } catch (error) {
        if (signal.aborted) return Promise.reject(abortError());
        if (error instanceof CameraCaptureError) return Promise.reject(error);
        return Promise.reject(new CameraCaptureError('failed'));
      } finally {
        if (canvas !== null) {
          canvas.width = 1;
          canvas.height = 1;
        }
      }
    },
  };
}
