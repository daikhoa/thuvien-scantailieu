import type { RgbaBackendInput } from './scanic-backend-contract';
import type { ScanicWorkerRequest, ScanicWorkerResponse } from './scanic-worker-backend';
import { ScanicDetectorRuntime } from './scanic-detector-runtime';
import { renderDocscanAsset } from './docscan-asset';
import { renderDocscanRgba } from './docscan-raster';

import { disposeShadowRuntime } from '../restoration/gcnet-runtime';

let detector: ScanicDetectorRuntime | null = null;

async function execute(request: ScanicWorkerRequest): Promise<unknown> {
  if (request.operation === 'dispose') {
    disposeShadowRuntime();
    detector = null;
    return null;
  }
  if (request.operation === 'initialize') {
    // Scanic's DOM-canvas fallback cannot run in a worker (notably Safari 16.0–16.3).
    if (typeof OffscreenCanvas === 'undefined' || typeof ImageData === 'undefined') {
      return { unavailable: true };
    }
    detector = new ScanicDetectorRuntime();
    await detector.initialize();
    return null;
  }
  if (request.operation === 'warp' || request.operation === 'warp-asset') {
    const result =
      request.operation === 'warp-asset'
        ? await renderDocscanAsset(
            request.asset,
            request.corners,
            request.filter,
            request.rotation,
            request.maximumOutputLongSide,
            request.analysis,
          )
        : await renderDocscanRgba(
            request.input,
            request.corners,
            request.filter,
            request.rotation,
            request.maximumOutputLongSide,
            request.analysis,
          );
    return result.image;
  }
  if (detector === null) throw new Error('Scanner not initialized.');
  const input: RgbaBackendInput = request.input;
  const image = new ImageData(input.pixels, input.dimensions.width, input.dimensions.height);
  const result = await detector.scan(image, input.detectionMode);
  // Do not send raw messages, debug images, contours or timings over the internal boundary.
  return {
    success: result.success,
    confidence: result.confidence,
    corners: result.corners,
    detector: result.detector,
  };
}

globalThis.addEventListener('message', (event: MessageEvent<ScanicWorkerRequest>) => {
  const request = event.data;
  void execute(request).then(
    (output: unknown) => {
      const response: ScanicWorkerResponse =
        typeof output === 'object' && output !== null && 'unavailable' in output
          ? { id: request.id, kind: 'failure', code: 'unavailable' }
          : { id: request.id, kind: 'success', output };
      if (
        (request.operation === 'warp' || request.operation === 'warp-asset') &&
        typeof output === 'object' &&
        output !== null &&
        'pixels' in output &&
        output.pixels instanceof Uint8ClampedArray
      ) {
        globalThis.postMessage(response, { transfer: [output.pixels.buffer] });
      } else {
        globalThis.postMessage(response);
      }
    },
    () => {
      const response: ScanicWorkerResponse = { id: request.id, kind: 'failure', code: 'failed' };
      globalThis.postMessage(response);
    },
  );
});
