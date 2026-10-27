import type { ScannerResult } from 'scanic';
import type { DocumentCorners } from '../../domain/document';
import { refineDocscanCorners, confirmDocscanCorners } from './docscan-corners';

type Scan = (image: ImageData) => Promise<ScannerResult>;
interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}
function quad(result: ScannerResult): DocumentCorners | null {
  const c = result.corners;
  if (c === null) return null;
  const values = [c.topLeft, c.topRight, c.bottomRight, c.bottomLeft] as const;
  return values.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)) ? values : null;
}
function shifted(corners: DocumentCorners, x: number, y: number): DocumentCorners {
  const move = (p: DocumentCorners[number]) => ({ x: p.x + x, y: p.y + y });
  return [move(corners[0]), move(corners[1]), move(corners[2]), move(corners[3])];
}
function withCorners(
  result: ScannerResult,
  corners: DocumentCorners,
  confidence: number,
): ScannerResult {
  return {
    ...result,
    success: true,
    confidence,
    corners: {
      topLeft: corners[0],
      topRight: corners[1],
      bottomRight: corners[2],
      bottomLeft: corners[3],
    },
  };
}
function rejected(result: ScannerResult): ScannerResult {
  return { ...result, success: false, corners: null, message: 'No confirmed document' };
}
function crop(image: ImageData, region: Region): ImageData {
  const data = new Uint8ClampedArray(region.width * region.height * 4);
  for (let row = 0; row < region.height; row++) {
    const start = ((region.y + row) * image.width + region.x) * 4;
    data.set(image.data.subarray(start, start + region.width * 4), row * region.width * 4);
  }
  return new ImageData(data, region.width, region.height);
}
function verificationRegion(image: ImageData, corners: DocumentCorners): Region {
  const xs = corners.map((p) => p.x),
    ys = corners.map((p) => p.y);
  const left = Math.min(...xs),
    top = Math.min(...ys),
    right = Math.max(...xs),
    bottom = Math.max(...ys);
  const x = Math.max(0, Math.min(image.width - 1, Math.floor(left - (right - left) * 0.2)));
  const y = Math.max(0, Math.min(image.height - 1, Math.floor(top - (bottom - top) * 0.2)));
  const endX = Math.max(x + 1, Math.min(image.width, Math.ceil(right + (right - left) * 0.2)));
  const endY = Math.max(y + 1, Math.min(image.height, Math.ceil(bottom + (bottom - top) * 0.2)));
  return { x, y, width: endX - x, height: endY - y };
}

/** Still photos only. At most two proposals and two verifications, all serial. */
export async function detectStillCorners(image: ImageData, scan: Scan): Promise<ScannerResult> {
  let last: ScannerResult | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const x = attempt === 0 ? 0 : Math.floor(image.width * 0.15);
    const y = attempt === 0 ? 0 : Math.floor(image.height * 0.15);
    const local =
      attempt === 0
        ? image
        : crop(image, { x, y, width: image.width - x * 2, height: image.height - y * 2 });
    const raw = await scan(local);
    last = raw;
    const corners = quad(raw);
    if (corners === null || typeof raw.confidence !== 'number') continue;
    let refined;
    try {
      refined = await refineDocscanCorners(local, corners, raw.confidence);
    } catch {
      return raw.confidence >= 0.5
        ? withCorners(raw, shifted(corners, x, y), raw.confidence)
        : rejected(raw);
    }
    if (refined.action === 'reject') continue;
    if (
      attempt > 0 &&
      refined.corners.some(
        (p) =>
          p.x < local.width * 0.02 ||
          p.y < local.height * 0.02 ||
          p.x > local.width * 0.98 ||
          p.y > local.height * 0.98,
      )
    )
      return rejected(raw);
    if (refined.action === 'accept')
      return withCorners(raw, shifted(refined.corners, x, y), raw.confidence);
    const region = verificationRegion(local, refined.corners);
    const verification = await scan(crop(local, region));
    const verified = quad(verification);
    if (
      verified !== null &&
      typeof verification.confidence === 'number' &&
      (await confirmDocscanCorners(
        refined.corners,
        shifted(verified, region.x, region.y),
        verification.confidence,
      ))
    )
      return withCorners(raw, shifted(refined.corners, x, y), verification.confidence);
    if (attempt === 1) return rejected(raw);
  }
  return rejected(last!);
}
