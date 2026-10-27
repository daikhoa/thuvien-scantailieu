import type { DocumentCorners, ImageDimensions, Point } from '../../domain/document';
import { isFinitePoint, isValidImageDimensions } from './coordinates';

export type QuadValidation =
  | { readonly valid: true; readonly area: number }
  | {
      readonly valid: false;
      readonly reason:
        | 'invalid-dimensions'
        | 'non-finite-point'
        | 'out-of-bounds'
        | 'self-intersection'
        | 'degenerate'
        | 'non-convex'
        | 'area-too-small';
    };

export interface ProjectiveTransform {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
  readonly g: number;
  readonly h: number;
}

type QuadFailure = Extract<QuadValidation, { valid: false }>['reason'];

/** A local relative error bound preserves thin quads in very long images. */
function turnDirection(a: Point, b: Point, c: Point): -1 | 0 | 1 {
  const bx = b.x - a.x;
  const by = b.y - a.y;
  const cx = c.x - a.x;
  const cy = c.y - a.y;
  const scale = Math.max(Math.abs(bx), Math.abs(by), Math.abs(cx), Math.abs(cy));
  if (scale === 0 || !Number.isFinite(scale)) return 0;
  const first = (bx / scale) * (cy / scale);
  const second = (by / scale) * (cx / scale);
  const determinant = first - second;
  const errorBound = 8 * Number.EPSILON * (Math.abs(first) + Math.abs(second));
  if (Math.abs(determinant) <= errorBound) return 0;
  return determinant > 0 ? 1 : -1;
}

function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

function onSegment(point: Point, a: Point, b: Point): boolean {
  return (
    point.x >= Math.min(a.x, b.x) &&
    point.x <= Math.max(a.x, b.x) &&
    point.y >= Math.min(a.y, b.y) &&
    point.y <= Math.max(a.y, b.y)
  );
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abc = turnDirection(a, b, c);
  const abd = turnDirection(a, b, d);
  const cda = turnDirection(c, d, a);
  const cdb = turnDirection(c, d, b);
  return (
    (abc * abd < 0 && cda * cdb < 0) ||
    (abc === 0 && onSegment(c, a, b)) ||
    (abd === 0 && onSegment(d, a, b)) ||
    (cda === 0 && onSegment(a, c, d)) ||
    (cdb === 0 && onSegment(b, c, d))
  );
}

function quadArea([a, b, c, d]: DocumentCorners): number {
  // Translate before multiplication to avoid cancellation at large image offsets.
  const first = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const second = (c.x - a.x) * (d.y - a.y) - (c.y - a.y) * (d.x - a.x);
  return Math.abs(first + second) / 2;
}

function geometryFailure(corners: DocumentCorners): QuadFailure | null {
  if (!corners.every(isFinitePoint)) return 'non-finite-point';
  if (
    corners.some((point, index) => corners.slice(0, index).some((other) => samePoint(point, other)))
  ) {
    return 'degenerate';
  }
  const [a, b, c, d] = corners;
  const turns = [
    turnDirection(a, b, c),
    turnDirection(b, c, d),
    turnDirection(c, d, a),
    turnDirection(d, a, b),
  ];
  if (turns.includes(0)) return 'degenerate';
  if (segmentsIntersect(a, b, c, d) || segmentsIntersect(b, c, d, a)) return 'self-intersection';
  if (!turns.every((turn) => turn === turns[0])) return 'non-convex';
  const area = quadArea(corners);
  return area > 0 && Number.isFinite(area) ? null : 'degenerate';
}

function hullSide(points: readonly Point[]): Point[] {
  const hull: Point[] = [];
  for (const point of points) {
    while (hull.length >= 2) {
      const previous = hull.at(-2);
      const last = hull.at(-1);
      if (previous === undefined || last === undefined || turnDirection(previous, last, point) > 0)
        break;
      hull.pop();
    }
    hull.push(point);
  }
  return hull;
}

/** Detector input is unordered; sum ties resolve by y then x, including diamond shapes. */
export function orderCorners(
  points: readonly [Point, Point, Point, Point],
): DocumentCorners | null {
  if (!points.every(isFinitePoint)) return null;
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (
    sorted.some((point, index) => {
      const previous = sorted[index - 1];
      return previous !== undefined && samePoint(point, previous);
    })
  )
    return null;
  const hull = [...hullSide(sorted).slice(0, -1), ...hullSide([...sorted].reverse()).slice(0, -1)];
  if (hull.length !== 4) return null;
  const anchor = [...hull].sort((a, b) => a.x + a.y - (b.x + b.y) || a.y - b.y || a.x - b.x)[0];
  if (anchor === undefined) return null;
  const start = hull.indexOf(anchor);
  const [a, b, c, d] = [...hull.slice(start), ...hull.slice(0, start)];
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  const corners: DocumentCorners = [a, b, c, d];
  return geometryFailure(corners) === null ? corners : null;
}

/** Validates supplied perimeter edges without silently reordering an invalid edit. */
export function validateQuad(
  corners: DocumentCorners,
  image: ImageDimensions,
  minimumArea: number,
): QuadValidation {
  if (!Number.isFinite(minimumArea) || minimumArea < 0) {
    throw new RangeError('Minimum quad area must be finite and nonnegative.');
  }
  if (!isValidImageDimensions(image)) return { valid: false, reason: 'invalid-dimensions' };
  if (!corners.every(isFinitePoint)) return { valid: false, reason: 'non-finite-point' };
  if (
    corners.some(
      (point) => point.x < 0 || point.y < 0 || point.x > image.width || point.y > image.height,
    )
  ) {
    return { valid: false, reason: 'out-of-bounds' };
  }
  const failure = geometryFailure(corners);
  if (failure !== null) return { valid: false, reason: failure };
  const area = quadArea(corners);
  return area < minimumArea ? { valid: false, reason: 'area-too-small' } : { valid: true, area };
}

// Browser camera capture does not expose reliable intrinsics across iOS and Android. The centered
// main-camera prior handles one-point perspective; two-axis evidence is blended in continuously.
const FALLBACK_FOCAL_LENGTH_RATIO = 0.75;
const MIN_PLAUSIBLE_FOCAL_LENGTH_RATIO = 0.45;
const MAX_PLAUSIBLE_FOCAL_LENGTH_RATIO = 1.8;
const FOCAL_INFERENCE_PROJECTIVE_SCALE = 1e-6;
const FOCAL_OUTLIER_DECAY = 4;

function edgeLength(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function getProjectiveTransform([
  topLeft,
  topRight,
  bottomRight,
  bottomLeft,
]: DocumentCorners): ProjectiveTransform | null {
  const deltaX1 = topRight.x - bottomRight.x;
  const deltaX2 = bottomLeft.x - bottomRight.x;
  const deltaY1 = topRight.y - bottomRight.y;
  const deltaY2 = bottomLeft.y - bottomRight.y;
  const sumX = topLeft.x - topRight.x + bottomRight.x - bottomLeft.x;
  const sumY = topLeft.y - topRight.y + bottomRight.y - bottomLeft.y;
  let g = 0;
  let h = 0;
  if (sumX !== 0 || sumY !== 0) {
    const determinant = deltaX1 * deltaY2 - deltaX2 * deltaY1;
    const scale = Math.max(Math.abs(deltaX1 * deltaY2), Math.abs(deltaX2 * deltaY1), 1);
    if (Math.abs(determinant) <= scale * Number.EPSILON * 16) return null;
    g = (sumX * deltaY2 - deltaX2 * sumY) / determinant;
    h = (deltaX1 * sumY - sumX * deltaY1) / determinant;
  }
  const transform = {
    a: topRight.x - topLeft.x + g * topRight.x,
    b: bottomLeft.x - topLeft.x + h * bottomLeft.x,
    c: topLeft.x,
    d: topRight.y - topLeft.y + g * topRight.y,
    e: bottomLeft.y - topLeft.y + h * bottomLeft.y,
    f: topLeft.y,
    g,
    h,
  };
  return Object.values(transform).every(Number.isFinite) ? transform : null;
}

function perspectiveAspectRatio(corners: DocumentCorners, source: ImageDimensions): number | null {
  const transform = getProjectiveTransform(corners);
  if (transform === null) return null;
  // Web capture does not provide the principal point, so use the image center as the optical center.
  const centerX = source.width / 2;
  const centerY = source.height / 2;
  const centeredFirstX = transform.a - centerX * transform.g;
  const centeredFirstY = transform.d - centerY * transform.g;
  const centeredSecondX = transform.b - centerX * transform.h;
  const centeredSecondY = transform.e - centerY * transform.h;
  const shortSide = Math.min(source.width, source.height);
  let focalLength = shortSide * FALLBACK_FOCAL_LENGTH_RATIO;
  const projectiveProduct = transform.g * transform.h;
  if (projectiveProduct !== 0) {
    const focalLengthSquared =
      -(centeredFirstX * centeredSecondX + centeredFirstY * centeredSecondY) / projectiveProduct;
    if (focalLengthSquared > 0 && Number.isFinite(focalLengthSquared)) {
      const candidate = Math.sqrt(focalLengthSquared);
      const minimum = shortSide * MIN_PLAUSIBLE_FOCAL_LENGTH_RATIO;
      const maximum = shortSide * MAX_PLAUSIBLE_FOCAL_LENGTH_RATIO;
      const boundedCandidate = Math.min(maximum, Math.max(minimum, candidate));
      // Detector noise can move a nearly one-axis quad across an arbitrary threshold. A smooth
      // confidence keeps the output ratio continuous while still trusting strong two-axis evidence.
      const projectiveStrength = Math.abs(projectiveProduct);
      const projectiveConfidence =
        projectiveStrength ** 2 / (projectiveStrength ** 2 + FOCAL_INFERENCE_PROJECTIVE_SCALE ** 2);
      const outlierDistance = Math.abs(Math.log(candidate / boundedCandidate));
      const plausibilityConfidence = Math.exp(-FOCAL_OUTLIER_DECAY * outlierDistance);
      const confidence = projectiveConfidence * plausibilityConfidence;
      focalLength += (boundedCandidate - focalLength) * confidence;
    }
  }

  const firstLength = Math.hypot(
    centeredFirstX / focalLength,
    centeredFirstY / focalLength,
    transform.g,
  );
  const secondLength = Math.hypot(
    centeredSecondX / focalLength,
    centeredSecondY / focalLength,
    transform.h,
  );
  const ratio = firstLength / secondLength;
  return ratio > 0 && Number.isFinite(ratio) ? ratio : null;
}

/** Uses camera perspective when source dimensions are known; otherwise preserves legacy edge sizing. */
export function getOutputDimensions(
  corners: DocumentCorners,
  source?: ImageDimensions,
): ImageDimensions {
  if (geometryFailure(corners) !== null)
    throw new RangeError('Output requires a nondegenerate convex quad.');
  const [a, b, c, d] = corners;
  const edgeWidth = Math.max(edgeLength(a, b), edgeLength(d, c));
  const edgeHeight = Math.max(edgeLength(a, d), edgeLength(b, c));
  let dimensions: ImageDimensions = {
    width: Math.ceil(edgeWidth),
    height: Math.ceil(edgeHeight),
  };
  if (source !== undefined) {
    if (!isValidImageDimensions(source) || !validateQuad(corners, source, 0).valid) {
      throw new RangeError('Output source dimensions must contain the document quad.');
    }
    const ratio = perspectiveAspectRatio(corners, source);
    if (ratio !== null) {
      const pixelBudget = edgeWidth * edgeHeight;
      dimensions = {
        width: Math.ceil(Math.sqrt(pixelBudget * ratio)),
        height: Math.ceil(Math.sqrt(pixelBudget / ratio)),
      };
    }
  }
  if (!isValidImageDimensions(dimensions))
    throw new RangeError('Output dimensions exceed numeric precision.');
  return dimensions;
}
