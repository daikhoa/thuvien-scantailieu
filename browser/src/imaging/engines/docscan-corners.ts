import type { DocumentCorners } from '../../domain/document';
import { DOCSCAN_WASM_BASE } from './docscan-assets';
import { loadDocscanModule } from './docscan-module';
import { ScannerEngineError } from './scanner-engine-error';

export async function refineDocscanCorners(
  image: ImageData,
  corners: DocumentCorners,
  confidence: number,
) {
  if (
    image.width < 1 ||
    image.height < 1 ||
    image.width > 960 ||
    image.height > 960 ||
    image.data.length !== image.width * image.height * 4 ||
    !corners.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
  )
    throw new ScannerEngineError('invalid-input');
  const module = await loadDocscanModule(DOCSCAN_WASM_BASE);
  let pixels = 0,
    points = 0;
  try {
    pixels = module._malloc(image.data.byteLength);
    points = module._malloc(80);
    if (!pixels || !points) throw new ScannerEngineError('out-of-memory');
    module.HEAPU8.set(image.data, pixels);
    module.HEAPF64.set(
      corners.flatMap((p) => [p.x, p.y]),
      points / 8,
    );
    const status = module._ds_wasm_refine_corners(
      pixels,
      image.width,
      image.height,
      points,
      confidence,
    );
    if (status !== 0) throw new ScannerEngineError(status === 8 ? 'out-of-memory' : 'failed');
    const values = module.HEAPF64.slice(points / 8, points / 8 + 10);
    const output = [0, 2, 4, 6].map((i) => ({
      x: values[i]!,
      y: values[i + 1]!,
    })) as unknown as DocumentCorners;
    const action = values[9] === 1 ? 'accept' : values[9] === 2 ? 'verify' : 'reject';
    return { corners: output, support: values[8]!, action } as const;
  } finally {
    if (pixels) module._free(pixels);
    if (points) module._free(points);
  }
}

export async function confirmDocscanCorners(
  candidate: DocumentCorners,
  confirmation: DocumentCorners,
  confidence: number,
): Promise<boolean> {
  const module = await loadDocscanModule(DOCSCAN_WASM_BASE);
  const pointer = module._malloc(128);
  if (!pointer) throw new ScannerEngineError('out-of-memory');
  try {
    module.HEAPF64.set(
      [...candidate, ...confirmation].flatMap((p) => [p.x, p.y]),
      pointer / 8,
    );
    return module._ds_wasm_confirm_corners(pointer, pointer + 64, confidence) === 1;
  } finally {
    module._free(pointer);
  }
}
