import type { RgbaBackendInput } from '../engines/scanic-backend-contract';

/** Small owned preview; never allocates or clones a full-resolution RGBA buffer. */
export function createRgbaThumbnail(input: RgbaBackendInput, maxSide: number): RgbaBackendInput {
  const scale = Math.min(1, maxSide / Math.max(input.dimensions.width, input.dimensions.height));
  const dimensions = {
    width: Math.max(1, Math.round(input.dimensions.width * scale)),
    height: Math.max(1, Math.round(input.dimensions.height * scale)),
  };
  const pixels = new Uint8ClampedArray(dimensions.width * dimensions.height * 4);
  for (let y = 0; y < dimensions.height; y++)
    for (let x = 0; x < dimensions.width; x++) {
      const source =
        (Math.min(input.dimensions.height - 1, Math.floor(y / scale)) * input.dimensions.width +
          Math.min(input.dimensions.width - 1, Math.floor(x / scale))) *
        4;
      const destination = (y * dimensions.width + x) * 4;
      for (let channel = 0; channel < 4; channel++)
        pixels[destination + channel] = input.pixels[source + channel] ?? 0;
    }
  return { dimensions, pixels };
}
