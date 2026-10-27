import type { RgbaBackendInput } from '../engines/scanic-backend-contract';
import { ScannerEngineError } from '../engines/scanner-engine-error';
import { isValidImageDimensions } from '../geometry/coordinates';
import { MAX_WORKING_IMAGE_PIXELS, MAX_WORKING_IMAGE_SIDE } from '../working-image-limits';

const TILE_COLUMNS = 8;
const TILE_ROWS = 8;
const HISTOGRAM_LEVELS = 256;
const MAX_ANALYSIS_SAMPLES = 65_536;

export interface DocumentQualityProfile {
  readonly brightness: {
    readonly mean: number;
    readonly darkPercentile: number;
    readonly brightPercentile: number;
    readonly darkRatio: number;
    readonly contrast: number;
    readonly saturation: number;
  };
  readonly illumination: {
    readonly kind: 'uniform' | 'uneven';
    readonly range: number;
    readonly darkLevel: number;
    readonly brightLevel: number;
  };
  readonly color: {
    readonly kind: 'mostly-neutral' | 'color-rich';
    readonly saturatedRatio: number;
  };
  readonly detail: {
    readonly kind: 'low' | 'medium' | 'high';
    readonly edgeScore: number;
    readonly periodicRatio?: number;
  };
  readonly clipping: {
    readonly highlightRatio: number;
  };
  readonly stages: {
    readonly normalizeIllumination: boolean;
    readonly normalizePaperTone: boolean;
    readonly protectColor: boolean;
    readonly sharpen: 'none' | 'gentle' | 'strong';
  };
}

function validateInput(input: RgbaBackendInput): void {
  const { width, height } = input.dimensions;
  if (
    !isValidImageDimensions(input.dimensions) ||
    Math.max(width, height) > MAX_WORKING_IMAGE_SIDE ||
    width * height > MAX_WORKING_IMAGE_PIXELS ||
    !(input.pixels instanceof Uint8ClampedArray) ||
    !(input.pixels.buffer instanceof ArrayBuffer) ||
    input.pixels.byteLength !== width * height * 4
  ) {
    throw new ScannerEngineError('invalid-input');
  }
}

function luminanceAt(input: RgbaBackendInput, x: number, y: number): number {
  const offset = (y * input.dimensions.width + x) * 4;
  const red = input.pixels[offset] ?? 0;
  const green = input.pixels[offset + 1] ?? 0;
  const blue = input.pixels[offset + 2] ?? 0;
  const alpha = input.pixels[offset + 3] ?? 0;
  const opaque = (54 * red + 183 * green + 19 * blue) >> 8;
  return Math.round((opaque * alpha + 255 * (255 - alpha)) / 255);
}

function percentile(histogram: Uint32Array, count: number, ratio: number): number {
  const target = Math.max(1, Math.ceil(count * ratio));
  let seen = 0;
  for (let value = 0; value < HISTOGRAM_LEVELS; value += 1) {
    seen += histogram[value] ?? 0;
    if (seen >= target) return value;
  }
  return 255;
}

function sampleStride(width: number, height: number): number {
  return Math.max(1, Math.ceil(Math.sqrt((width * height) / MAX_ANALYSIS_SAMPLES)));
}

/** Bounded, allocation-light analysis used to route post-capture restoration stages. */
export function analyzeDocumentQuality(input: RgbaBackendInput): DocumentQualityProfile {
  validateInput(input);
  const { width, height } = input.dimensions;
  const stride = sampleStride(width, height);
  const tileCount = TILE_COLUMNS * TILE_ROWS;
  const tileHistograms = new Uint32Array(tileCount * HISTOGRAM_LEVELS);
  const tileSamples = new Uint32Array(tileCount);
  let samples = 0;
  let saturated = 0;
  let clippedHighlights = 0;
  let edgeSamples = 0;
  let edgeTotal = 0;
  let periodicSamples = 0;
  let sum = 0;
  let squaredSum = 0;
  let darkPixels = 0;
  let saturation = 0;
  const histogram = new Uint32Array(256);

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const offset = (y * width + x) * 4;
      const red = input.pixels[offset] ?? 0;
      const green = input.pixels[offset + 1] ?? 0;
      const blue = input.pixels[offset + 2] ?? 0;
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const value = luminanceAt(input, x, y);
      sum += value;
      squaredSum += value * value;
      if (value < 40) darkPixels++;
      saturation += maximum === 0 ? 0 : (maximum - minimum) / maximum;
      histogram[value] = (histogram[value] ?? 0) + 1;
      const tileX = Math.min(TILE_COLUMNS - 1, Math.floor((x * TILE_COLUMNS) / width));
      const tileY = Math.min(TILE_ROWS - 1, Math.floor((y * TILE_ROWS) / height));
      const tile = tileY * TILE_COLUMNS + tileX;
      tileHistograms[tile * HISTOGRAM_LEVELS + value] =
        (tileHistograms[tile * HISTOGRAM_LEVELS + value] ?? 0) + 1;
      tileSamples[tile] = (tileSamples[tile] ?? 0) + 1;
      samples += 1;
      if (maximum - minimum >= 32 && maximum >= 96) saturated += 1;
      if (maximum >= 250) clippedHighlights += 1;

      if (x >= stride && y >= stride && x + stride < width && y + stride < height) {
        const center = value;
        const laplacian = Math.abs(
          4 * center -
            luminanceAt(input, x - stride, y) -
            luminanceAt(input, x + stride, y) -
            luminanceAt(input, x, y - stride) -
            luminanceAt(input, x, y + stride),
        );
        edgeTotal += laplacian / 4;
        edgeSamples += 1;
        const left = center - luminanceAt(input, x - stride, y),
          right = luminanceAt(input, x + stride, y) - center;
        const above = center - luminanceAt(input, x, y - stride),
          below = luminanceAt(input, x, y + stride) - center;
        const alternates = (a: number, b: number) =>
          a * b < 0 &&
          Math.min(Math.abs(a), Math.abs(b)) >= 3 &&
          Math.max(Math.abs(a), Math.abs(b)) <= 32;
        if (alternates(left, right) || alternates(above, below)) periodicSamples++;
      }
    }
  }

  const backgroundHistogram = new Uint32Array(HISTOGRAM_LEVELS);
  let backgroundSamples = 0;
  for (let tile = 0; tile < tileCount; tile += 1) {
    const count = tileSamples[tile] ?? 0;
    if (count === 0) continue;
    const start = tile * HISTOGRAM_LEVELS;
    const level = percentile(tileHistograms.subarray(start, start + HISTOGRAM_LEVELS), count, 0.85);
    backgroundHistogram[level] = (backgroundHistogram[level] ?? 0) + 1;
    backgroundSamples += 1;
  }

  const darkLevel = percentile(backgroundHistogram, backgroundSamples, 0.1);
  const brightLevel = percentile(backgroundHistogram, backgroundSamples, 0.9);
  const illuminationRange = brightLevel - darkLevel;
  const saturatedRatio = saturated / samples;
  const highlightRatio = clippedHighlights / samples;
  const edgeScore = edgeSamples === 0 ? 0 : edgeTotal / edgeSamples;
  const colorKind = saturatedRatio >= 0.12 ? 'color-rich' : 'mostly-neutral';
  const detailKind = edgeScore >= 42 ? 'high' : edgeScore >= 14 ? 'medium' : 'low';
  const protectColor = colorKind === 'color-rich';
  const sharpen =
    detailKind === 'high'
      ? 'none'
      : protectColor
        ? 'gentle'
        : detailKind === 'low'
          ? 'strong'
          : 'gentle';

  return {
    brightness: {
      mean: sum / samples,
      darkPercentile: percentile(histogram, samples, 0.05),
      brightPercentile: percentile(histogram, samples, 0.95),
      darkRatio: darkPixels / samples,
      contrast: Math.sqrt(Math.max(0, squaredSum / samples - (sum / samples) ** 2)),
      saturation: saturation / samples,
    },
    illumination: {
      kind: illuminationRange >= 18 ? 'uneven' : 'uniform',
      range: illuminationRange,
      darkLevel,
      brightLevel,
    },
    color: { kind: colorKind, saturatedRatio },
    detail: {
      kind: detailKind,
      edgeScore,
      periodicRatio: edgeSamples === 0 ? 0 : periodicSamples / edgeSamples,
    },
    clipping: { highlightRatio },
    stages: {
      normalizeIllumination: illuminationRange >= 18 && highlightRatio < 0.55,
      normalizePaperTone:
        !protectColor && brightLevel >= 64 && brightLevel < 232 && highlightRatio < 0.55,
      protectColor,
      sharpen,
    },
  };
}
