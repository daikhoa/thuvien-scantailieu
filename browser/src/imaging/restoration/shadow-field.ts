import type { RgbaBackendInput } from '../engines/scanic-backend-contract';

export interface ShadowField {
  readonly width: number;
  readonly height: number;
  /** GCNet uses BGR planes, normalized to 0..1. */
  readonly data: Float32Array;
}

function validateRaster(input: RgbaBackendInput): void {
  const { width, height } = input.dimensions;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 16384 ||
    height > 16384 ||
    input.pixels.length !== width * height * 4
  )
    throw new RangeError('invalid-input');
}

/** Sample illumination only; the original pixel buffer is never resized or replaced. */
export function createShadowSample(input: RgbaBackendInput): ShadowField {
  validateRaster(input);
  const source = input.dimensions;
  const scale = Math.min(1, 384 / Math.max(source.width, source.height));
  // Rounding error at exactly 384 must not allocate a thirteenth 32-pixel block.
  const width = Math.min(384, Math.max(32, Math.ceil((source.width * scale) / 32) * 32));
  const height = Math.min(384, Math.max(32, Math.ceil((source.height * scale) / 32) * 32));
  const plane = width * height;
  const data = new Float32Array(plane * 3);
  const value = (x: number, y: number, channel: number) => {
    const at = (y * source.width + x) * 4;
    const alpha = (input.pixels[at + 3] ?? 0) / 255;
    return ((input.pixels[at + channel] ?? 0) * alpha + 255 * (1 - alpha)) / 255;
  };
  for (let y = 0; y < height; y++) {
    const yy = Math.max(0, Math.min(source.height - 1, ((y + 0.5) * source.height) / height - 0.5));
    const top = Math.floor(yy),
      bottom = Math.min(top + 1, source.height - 1),
      fy = yy - top;
    for (let x = 0; x < width; x++) {
      const xx = Math.max(0, Math.min(source.width - 1, ((x + 0.5) * source.width) / width - 0.5));
      const left = Math.floor(xx),
        right = Math.min(left + 1, source.width - 1),
        fx = xx - left;
      for (let c = 0; c < 3; c++) {
        const a = value(left, top, 2 - c) * (1 - fx) + value(right, top, 2 - c) * fx;
        const b = value(left, bottom, 2 - c) * (1 - fx) + value(right, bottom, 2 - c) * fx;
        data[c * plane + y * width + x] = a * (1 - fy) + b * fy;
      }
    }
  }
  return { width, height, data };
}

/** Validate the whole field before mutating; bounded gains cannot invent missing strokes. */
export function applyShadowField(input: RgbaBackendInput, field: ShadowField): void {
  validateRaster(input);
  const { width, height, data } = field;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 384 ||
    height > 384 ||
    data.length !== width * height * 3 ||
    data.some((value) => !Number.isFinite(value) || value <= 0 || value > 1.5)
  )
    throw new RangeError('invalid-shadow-field');
  const source = input.dimensions,
    plane = width * height;
  const row = new Float64Array(width * 3);
  for (let y = 0; y < source.height; y++) {
    const yy = Math.max(0, Math.min(height - 1, ((y + 0.5) * height) / source.height - 0.5));
    const top = Math.floor(yy),
      bottom = Math.min(top + 1, height - 1),
      fy = yy - top;
    for (let c = 0; c < 3; c++)
      for (let x = 0; x < width; x++)
        row[c * width + x] =
          (data[c * plane + top * width + x] ?? 1) * (1 - fy) +
          (data[c * plane + bottom * width + x] ?? 1) * fy;
    for (let x = 0; x < source.width; x++) {
      const at = (y * source.width + x) * 4;
      if (input.pixels[at + 3] !== 255) continue;
      const xx = Math.max(0, Math.min(width - 1, ((x + 0.5) * width) / source.width - 0.5));
      const left = Math.floor(xx),
        right = Math.min(left + 1, width - 1),
        fx = xx - left;
      for (let c = 0; c < 3; c++) {
        const light = (row[c * width + left] ?? 1) * (1 - fx) + (row[c * width + right] ?? 1) * fx;
        const channel = at + 2 - c;
        input.pixels[channel] = Math.min(
          255,
          Math.round((input.pixels[channel] ?? 0) * Math.max(1, Math.min(4, 0.96 / light))),
        );
      }
    }
  }
}
