import {
  createBackgroundPageProcessor,
  type BackgroundPageProcessorOptions,
  type ProcessedScanPage,
  type ScanPageSource,
} from './features/scanner/background-page-processor';
import { ScannerEngineError } from './imaging/engines/scanner-engine-error';
import { createImagePdf } from './features/export/image-pdf';
import type {
  CropRegion,
  EditRecipe,
  FilterMode,
  ImageAsset,
  QuarterTurn,
} from './domain/document';

export type {
  CropRegion,
  EditRecipe,
  FilterMode,
  ImageAsset,
  ImageDimensions,
  DocumentCorners,
  RenderedVariant,
} from './domain/document';
export { createScanicEngine as createScannerEngine } from './imaging/engines/scanic-classical-engine';
export { createImagePdf, PdfExportError } from './features/export/image-pdf';
export { importImage, ImageImportError } from './features/camera/image-import';
export { createDocumentRecipe } from './features/editor/document-filters';
export { SDK_VERSION } from './sdk-assets';

export interface ProcessOptions {
  readonly signal?: AbortSignal;
  readonly crop?: CropRegion;
  readonly filter?: FilterMode;
  readonly rotation?: QuarterTurn;
  readonly onOriginal?: (original: ImageAsset) => void;
}
export interface Docscan {
  process(
    source: ScanPageSource,
    options?: ProcessOptions,
  ): Promise<ProcessedScanPage & { readonly image: ImageAsset }>;
  render(
    original: ImageAsset,
    recipe: EditRecipe,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ProcessedScanPage>;
  processPdf(sources: readonly ScanPageSource[], options?: ProcessOptions): Promise<Blob>;
  createPdf(
    pages: readonly (ImageAsset | ProcessedScanPage)[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<Blob>;
  releaseWhenIdle(): Promise<void>;
  dispose(): Promise<void>;
}
/** All sessions/models/workers belong to this instance. No caller-side model setup. */
export function createDocscan(options: BackgroundPageProcessorOptions = {}): Docscan {
  const processor = createBackgroundPageProcessor(options);
  const lifetime = new AbortController();
  let disposing: Promise<void> | undefined;
  let pending = 0;
  const api: Docscan = {
    async process(source, request = {}) {
      if (pending >= 64) throw new ScannerEngineError('unavailable');
      pending++;
      try {
        const page = await processor.enqueue(
          source,
          request.signal ?? lifetime.signal,
          undefined,
          null,
          {
            ...(request.crop ? { crop: request.crop } : {}),
            ...(request.filter ? { filter: request.filter } : {}),
            ...(request.rotation === undefined ? {} : { rotation: request.rotation }),
            ...(request.onOriginal ? { onOriginal: request.onOriginal } : {}),
          },
        );
        return { ...page, image: page.variant.image };
      } finally {
        pending--;
      }
    },
    render(original, recipe, request = {}) {
      if (!processor.render) return Promise.reject(new Error('Document renderer unavailable.'));
      return processor.render(original, recipe, request.signal ?? lifetime.signal);
    },
    async processPdf(sources, request = {}) {
      if (!Array.isArray(sources) || sources.length === 0 || sources.length > 64)
        throw new ScannerEngineError('invalid-input');
      const pages: ImageAsset[] = [];
      for (const source of sources) pages.push((await api.process(source, request)).image);
      return api.createPdf(pages, request);
    },
    async createPdf(pages, request = {}) {
      if (lifetime.signal.aborted) {
        const error = new Error('Document processing cancelled.');
        error.name = 'AbortError';
        throw error;
      }
      const controller = new AbortController();
      const cancel = () => {
        controller.abort();
      };
      const signal = request.signal ?? lifetime.signal;
      signal.addEventListener('abort', cancel, { once: true });
      lifetime.signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) controller.abort();
      try {
        return await createImagePdf(
          pages.map((page) => ('variant' in page ? page.variant.image : page)),
          controller.signal,
        );
      } finally {
        signal.removeEventListener('abort', cancel);
        lifetime.signal.removeEventListener('abort', cancel);
      }
    },
    releaseWhenIdle: () => processor.releaseWhenIdle?.() ?? Promise.resolve(),
    dispose() {
      lifetime.abort();
      disposing ??= processor.dispose();
      return disposing;
    },
  };
  return api;
}
