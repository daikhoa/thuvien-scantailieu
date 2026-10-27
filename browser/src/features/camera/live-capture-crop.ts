import type { CropRegion, ImageDimensions, Point } from '../../domain/document';
import { isValidImageDimensions } from '../../imaging/geometry/coordinates';
import type { LiveDetectionResult } from '../scanner/detection-scheduler';

interface CenteredSourceArea {
  readonly width: number;
  readonly height: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

function centeredSourceArea(
  preview: ImageDimensions,
  captured: ImageDimensions,
): CenteredSourceArea {
  const previewRatio = preview.width / preview.height;
  const capturedRatio = captured.width / captured.height;
  if (capturedRatio > previewRatio) {
    const width = captured.height * previewRatio;
    return {
      width,
      height: captured.height,
      offsetX: (captured.width - width) / 2,
      offsetY: 0,
    };
  }
  const height = captured.width / previewRatio;
  return {
    width: captured.width,
    height,
    offsetX: 0,
    offsetY: (captured.height - height) / 2,
  };
}

function mapPoint(point: Point, preview: ImageDimensions, capturedArea: CenteredSourceArea): Point {
  return {
    x: capturedArea.offsetX + (point.x / preview.width) * capturedArea.width,
    y: capturedArea.offsetY + (point.y / preview.height) * capturedArea.height,
  };
}

/** Freezes the visible live guide as a crop in the captured image's coordinate space. */
export function mapLiveDetectionToCrop(
  detection: LiveDetectionResult | null,
  captured: ImageDimensions,
): CropRegion {
  if (!isValidImageDimensions(captured)) throw new RangeError('Invalid captured dimensions.');
  if (detection === null || detection.kind === 'full-frame') return { kind: 'full-frame' };
  if (!isValidImageDimensions(detection.dimensions)) {
    throw new RangeError('Invalid live detection dimensions.');
  }
  const area = centeredSourceArea(detection.dimensions, captured);
  const corners = [
    mapPoint(detection.corners[0], detection.dimensions, area),
    mapPoint(detection.corners[1], detection.dimensions, area),
    mapPoint(detection.corners[2], detection.dimensions, area),
    mapPoint(detection.corners[3], detection.dimensions, area),
  ] as const;
  return { kind: 'document', corners };
}
