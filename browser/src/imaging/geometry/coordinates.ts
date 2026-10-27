import type { DocumentCorners, ImageDimensions, Point, QuarterTurn } from '../../domain/document';

export function isValidImageDimensions(image: ImageDimensions): boolean {
  return (
    Number.isSafeInteger(image.width) &&
    Number.isSafeInteger(image.height) &&
    image.width > 0 &&
    image.height > 0
  );
}

export function isFinitePoint(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function assertDimensions(image: ImageDimensions): void {
  if (!isValidImageDimensions(image)) {
    throw new RangeError('Image dimensions must be positive safe integers.');
  }
}

function assertPoint(point: Point): void {
  if (!isFinitePoint(point)) throw new RangeError('Point coordinates must be finite.');
}

function assertRotation(rotation: number): void {
  if (rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270) {
    throw new RangeError('Rotation must be a clockwise quarter turn.');
  }
}

/** Coordinates stay fractional and unclamped so invalid edits remain detectable. */
export function scalePoint(point: Point, from: ImageDimensions, to: ImageDimensions): Point {
  assertDimensions(from);
  assertDimensions(to);
  assertPoint(point);
  // Normalize first so an exact source boundary remains an exact target boundary.
  const scaled = { x: (point.x / from.width) * to.width, y: (point.y / from.height) * to.height };
  assertPoint(scaled);
  return scaled;
}

export function scaleCorners(
  corners: DocumentCorners,
  from: ImageDimensions,
  to: ImageDimensions,
): DocumentCorners {
  return [
    scalePoint(corners[0], from, to),
    scalePoint(corners[1], from, to),
    scalePoint(corners[2], from, to),
    scalePoint(corners[3], from, to),
  ];
}

/** Continuous image-edge coordinates use width/height rather than width/height minus one. */
export function rotatePoint(point: Point, image: ImageDimensions, rotation: QuarterTurn): Point {
  assertDimensions(image);
  assertPoint(point);
  assertRotation(rotation);
  switch (rotation) {
    case 0:
      return { x: point.x, y: point.y };
    case 90:
      return { x: image.height - point.y, y: point.x };
    case 180:
      return { x: image.width - point.x, y: image.height - point.y };
    case 270:
      return { x: point.y, y: image.width - point.x };
  }
}

export function rotateDimensions(image: ImageDimensions, rotation: QuarterTurn): ImageDimensions {
  assertDimensions(image);
  assertRotation(rotation);
  return rotation === 90 || rotation === 270
    ? { width: image.height, height: image.width }
    : { width: image.width, height: image.height };
}

/** Relabel corners by quarter turn while preserving the document's edge correspondence. */
export function rotateCorners(
  corners: DocumentCorners,
  image: ImageDimensions,
  rotation: QuarterTurn,
): DocumentCorners {
  const [a, b, c, d] = corners;
  const turned: DocumentCorners = [
    rotatePoint(a, image, rotation),
    rotatePoint(b, image, rotation),
    rotatePoint(c, image, rotation),
    rotatePoint(d, image, rotation),
  ];
  switch (rotation) {
    case 0:
      return turned;
    case 90:
      return [turned[3], turned[0], turned[1], turned[2]];
    case 180:
      return [turned[2], turned[3], turned[0], turned[1]];
    case 270:
      return [turned[1], turned[2], turned[3], turned[0]];
  }
}
