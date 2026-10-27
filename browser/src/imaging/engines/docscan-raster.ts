import type {
  DocumentCorners,
  FilterMode,
  ImageDimensions,
  QuarterTurn,
} from '../../domain/document';
import type { LocalRestorationAnalysis } from '../restoration/local-restoration-client';
import type { ShadowField } from '../restoration/shadow-field';
import { shadowFailureCode } from '../restoration/shadow-runtime-error';
import { ScannerEngineError, type RgbaBackendInput } from './scanic-backend-contract';
import { DOCSCAN_WASM_BASE } from './docscan-assets';
import { loadDocscanModule } from './docscan-module';
import { validateQuad } from '../geometry/quad';

export interface SourceRegion extends ImageDimensions {
  readonly x: number;
  readonly y: number;
}
const FILTERS: Record<FilterMode, number> = {
  original: 0,
  'ocr-color': 1,
  'enhanced-color': 2,
  grayscale: 3,
  'black-and-white': 4,
  'shadow-removal': 5,
};
let running = false;
function checkStatus(status: number): void {
  if (status !== 0)
    throw new ScannerEngineError(
      status === 8 ? 'out-of-memory' : status === 1 || status === 3 ? 'invalid-input' : 'failed',
    );
}
function validShape(size: ImageDimensions, maximumSide: number, maximumPixels: number): boolean {
  return (
    Number.isInteger(size.width) &&
    Number.isInteger(size.height) &&
    size.width > 0 &&
    size.height > 0 &&
    size.width <= maximumSide &&
    size.height <= maximumSide &&
    size.width * size.height <= maximumPixels
  );
}
function checkRange(heap: Uint8Array, pointer: number, bytes: number): void {
  if (!Number.isInteger(pointer) || pointer <= 0 || pointer + bytes > heap.byteLength)
    throw new ScannerEngineError('failed');
}

/** Browser boundary only: C++ owns geometry, sampling, model policy and final pixels. */
export async function renderDocscanRegions(
  source: ImageDimensions,
  corners: DocumentCorners,
  read: (region: SourceRegion) => RgbaBackendInput,
  filter: FilterMode,
  rotation: QuarterTurn,
  maximum = 3000,
  analysis?: LocalRestorationAnalysis,
  onSourceConsumed?: () => void,
): Promise<{
  readonly image: RgbaBackendInput;
  readonly reservedBytes: number;
  readonly inputPixelBytes: number;
}> {
  if (
    !validShape(source, 16384, 50_000_000) ||
    !validateQuad(corners, source, 1).valid ||
    !Object.hasOwn(FILTERS, filter) ||
    ![0, 90, 180, 270].includes(rotation) ||
    !Number.isInteger(maximum) ||
    maximum < 1 ||
    maximum > 3000
  )
    throw new ScannerEngineError('invalid-input');
  const module = await loadDocscanModule(DOCSCAN_WASM_BASE);
  if (running) throw new ScannerEngineError('unavailable');
  running = true;
  let points = 0,
    patch = 0,
    capacity = 0,
    fieldPointer = 0,
    appearance = 0;
  try {
    const started = performance.now();
    points = module._malloc(64);
    if (!points) throw new ScannerEngineError('out-of-memory');
    module.HEAPF64.set(
      corners.flatMap((point) => [point.x, point.y]),
      points / 8,
    );
    checkStatus(module._ds_wasm_begin(points, source.width, source.height, maximum));
    const count = module._ds_wasm_patch_count();
    if (!Number.isInteger(count) || count < 1 || count > 100_000)
      throw new ScannerEngineError('failed');
    for (let index = 0; index < count; index++) {
      const at = module._ds_wasm_patch(index);
      checkRange(module.HEAPU8, at, 16);
      const [x = -1, y = -1, width = 0, height = 0] = new Int32Array(module.HEAPU8.buffer, at, 4);
      const region = { x, y, width, height };
      if (
        !validShape(region, 4096, 1024 * 1024) ||
        x < 0 ||
        y < 0 ||
        x + width > source.width ||
        y + height > source.height
      )
        throw new ScannerEngineError('failed');
      const input = read(region);
      const bytes = width * height * 4;
      if (
        input.dimensions.width !== width ||
        input.dimensions.height !== height ||
        !(input.pixels instanceof Uint8ClampedArray) ||
        input.pixels.byteLength !== bytes
      )
        throw new ScannerEngineError('invalid-input');
      if (capacity < bytes) {
        if (patch) module._free(patch);
        patch = 0;
        patch = module._malloc(bytes);
        if (!patch) throw new ScannerEngineError('out-of-memory');
        capacity = bytes;
      }
      module.HEAPU8.set(input.pixels, patch);
      checkStatus(module._ds_wasm_write_patch(patch, index));
      // The DOM compatibility realm must keep navigation/disposal responsive as well.
      if (typeof document !== 'undefined' && index % 8 === 7)
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
    }
    // All original-resolution source reads are finished. Do not retain decoder
    // surfaces while the separate shadow runtime allocates model activations.
    if (patch) {
      module._free(patch);
      patch = 0;
    }
    onSourceConsumed?.();
    const warped = performance.now();
    if (analysis?.defectScores) {
      const scores = analysis.defectScores;
      const values = [
        scores.shadow,
        scores.curved,
        scores.blur,
        scores.moire,
        scores.finger,
        scores.lowContrast,
        scores.colorDocument,
      ];
      if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1))
        throw new ScannerEngineError('invalid-input');
      appearance = module._malloc(56);
      if (!appearance) throw new ScannerEngineError('out-of-memory');
      module.HEAPF64.set(values, appearance / 8);
    }
    checkStatus(module._ds_wasm_prepare(FILTERS[filter], appearance));
    let field: ShadowField | undefined;
    let enhancement: RgbaBackendInput['enhancement'];
    let enhancementFailure: RgbaBackendInput['enhancementFailure'];
    if (filter === 'enhanced-color') enhancement = 'local';
    if (module._ds_wasm_needs_model()) {
      const width = module._ds_wasm_sample_width(),
        height = module._ds_wasm_sample_height();
      if (!validShape({ width, height }, 384, 384 * 384)) throw new ScannerEngineError('failed');
      const at = module._ds_wasm_sample(),
        length = width * height * 3;
      checkRange(module.HEAPU8, at, length * 4);
      const sample = {
        width,
        height,
        data: new Float32Array(module.HEAPU8.buffer, at, length).slice(),
      };
      try {
        const { predictIllumination } = await import('../restoration/gcnet-runtime');
        field = await predictIllumination(sample);
        if (filter === 'enhanced-color') enhancement = 'shadow-model';
      } catch (error) {
        if (filter === 'shadow-removal') throw error;
        enhancement = 'model-unavailable';
        enhancementFailure = shadowFailureCode(error, 'runtime');
      }
    }
    if (field) {
      fieldPointer = module._malloc(field.data.byteLength);
      if (!fieldPointer) throw new ScannerEngineError('out-of-memory');
      module.HEAPU8.set(
        new Uint8Array(field.data.buffer, field.data.byteOffset, field.data.byteLength),
        fieldPointer,
      );
    }
    checkStatus(
      module._ds_wasm_finish(
        FILTERS[filter],
        rotation,
        fieldPointer,
        field?.width ?? 0,
        field?.height ?? 0,
      ),
    );
    const dimensions = { width: module._ds_wasm_width(), height: module._ds_wasm_height() };
    if (!validShape(dimensions, maximum, maximum * maximum)) throw new ScannerEngineError('failed');
    const length = dimensions.width * dimensions.height * 4,
      at = module._ds_wasm_output();
    checkRange(module.HEAPU8, at, length);
    const pixels = new Uint8ClampedArray(length);
    pixels.set(module.HEAPU8.subarray(at, at + length));
    return {
      image: {
        dimensions,
        pixels,
        timings: { warp3000: warped - started, restorationFilter: performance.now() - warped },
        ...(enhancement ? { enhancement } : {}),
        ...(enhancementFailure ? { enhancementFailure } : {}),
      },
      reservedBytes: module.HEAPU8.buffer.byteLength,
      inputPixelBytes: capacity,
    };
  } finally {
    module._ds_wasm_release();
    if (points) module._free(points);
    if (patch) module._free(patch);
    if (fieldPointer) module._free(fieldPointer);
    if (appearance) module._free(appearance);
    running = false;
  }
}

export async function renderDocscanRgba(
  input: RgbaBackendInput,
  corners: DocumentCorners,
  filter: FilterMode,
  rotation: QuarterTurn,
  maximum?: number,
  analysis?: LocalRestorationAnalysis,
) {
  if (
    !(input.pixels instanceof Uint8ClampedArray) ||
    input.pixels.byteLength !== input.dimensions.width * input.dimensions.height * 4
  )
    throw new ScannerEngineError('invalid-input');
  return renderDocscanRegions(
    input.dimensions,
    corners,
    (region) => {
      const pixels = new Uint8ClampedArray(region.width * region.height * 4);
      for (let row = 0; row < region.height; row++) {
        const at = ((region.y + row) * input.dimensions.width + region.x) * 4;
        pixels.set(input.pixels.subarray(at, at + region.width * 4), row * region.width * 4);
      }
      return { dimensions: region, pixels };
    },
    filter,
    rotation,
    maximum,
    analysis,
  );
}
