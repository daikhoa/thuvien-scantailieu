import type { ImageAsset } from '../../domain/document';
import { validateRasterAsset } from '../../imaging/codecs/browser-rgba-codec';

export type PdfExportFailureCode = 'invalid-input' | 'failed';

const SAFE_MESSAGES: Readonly<Record<PdfExportFailureCode, string>> = {
  'invalid-input': 'The PDF input is invalid.',
  failed: 'The PDF could not be created.',
};
const PDF_POINTS_PER_INCH = 72;
const RENDERED_PIXELS_PER_INCH = 300;

export class PdfExportError extends Error {
  override readonly name = 'PdfExportError';

  constructor(readonly code: PdfExportFailureCode) {
    super(SAFE_MESSAGES[code]);
  }
}

function abortError(): Error {
  const error = new Error('PDF export cancelled.');
  error.name = 'AbortError';
  return error;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function validatePage(page: ImageAsset): void {
  try {
    validateRasterAsset(page);
  } catch {
    throw new PdfExportError('invalid-input');
  }
  if (page.blob.type !== 'image/png' && page.blob.type !== 'image/jpeg') {
    throw new PdfExportError('invalid-input');
  }
}

/** Creates image-only PDF pages at a consistent 300 PPI without stretching their ratios. */
export async function createImagePdf(
  pages: readonly ImageAsset[],
  signal: AbortSignal,
): Promise<Blob> {
  checkAbort(signal);
  if (pages.length === 0) throw new PdfExportError('invalid-input');
  for (const page of pages) validatePage(page);

  try {
    const { PDFDocument } = await import('pdf-lib');
    checkAbort(signal);
    const document = await PDFDocument.create();
    document.setProducer('clonecamscanner');
    document.setCreator('clonecamscanner');
    for (const source of pages) {
      checkAbort(signal);
      const encoded = new Uint8Array(await source.blob.arrayBuffer());
      checkAbort(signal);
      const image =
        source.blob.type === 'image/png'
          ? await document.embedPng(encoded)
          : await document.embedJpg(encoded);
      const width = (source.dimensions.width * PDF_POINTS_PER_INCH) / RENDERED_PIXELS_PER_INCH;
      const height = (source.dimensions.height * PDF_POINTS_PER_INCH) / RENDERED_PIXELS_PER_INCH;
      const page = document.addPage([width, height]);
      page.drawImage(image, { x: 0, y: 0, width, height });
    }
    checkAbort(signal);
    const bytes = await document.save({ useObjectStreams: true, addDefaultPage: false });
    checkAbort(signal);
    const ownedBytes = new Uint8Array(bytes.byteLength);
    ownedBytes.set(bytes);
    return new Blob([ownedBytes.buffer], { type: 'application/pdf' });
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (error instanceof PdfExportError) throw error;
    throw new PdfExportError('failed');
  }
}
