export interface DocscanModule {
  _ds_wasm_refine_corners: (
    rgba: number,
    width: number,
    height: number,
    points: number,
    confidence: number,
  ) => number;
  _ds_wasm_confirm_corners: (candidate: number, confirmation: number, confidence: number) => number;
  HEAPU8: Uint8Array<ArrayBuffer>;
  HEAPF64: Float64Array<ArrayBuffer>;
  _malloc: (bytes: number) => number;
  _free: (pointer: number) => void;
  _ds_wasm_release: () => void;
  _ds_wasm_output: () => number;
  _ds_wasm_width: () => number;
  _ds_wasm_height: () => number;
  _ds_wasm_begin: (points: number, width: number, height: number, maximum: number) => number;
  _ds_wasm_patch_count: () => number;
  _ds_wasm_patch: (index: number) => number;
  _ds_wasm_write_patch: (pointer: number, index: number) => number;
  _ds_wasm_prepare: (filter: number, appearance: number) => number;
  _ds_wasm_needs_model: () => number;
  _ds_wasm_sample: () => number;
  _ds_wasm_sample_width: () => number;
  _ds_wasm_sample_height: () => number;
  _ds_wasm_finish: (
    filter: number,
    rotation: number,
    field: number,
    width: number,
    height: number,
  ) => number;
}

let runtime: Promise<DocscanModule> | null = null;
export function loadDocscanModule(assetBase: string): Promise<DocscanModule> {
  runtime ??= (async () => {
    const path = `${assetBase}docscan.mjs`;
    const factory = (await import(/* @vite-ignore */ path)) as {
      default: () => Promise<DocscanModule>;
    };
    return factory.default();
  })().catch((error: unknown) => {
    runtime = null;
    throw error;
  });
  return runtime;
}
