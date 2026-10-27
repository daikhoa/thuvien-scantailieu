import type { ImageDimensions } from '../../domain/document';

export const RASTER_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/avif',
] as const;
export const SUPPORTED_RASTER_TYPES = new Set<string>(RASTER_MIME_TYPES);
export type SupportedRasterType = (typeof RASTER_MIME_TYPES)[number];

function matches(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function detectedType(bytes: Uint8Array): SupportedRasterType | null {
  if (matches(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (matches(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (matches(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && matches(bytes, 8, [0x57, 0x45, 0x42, 0x50])) {
    return 'image/webp';
  }
  if (matches(bytes, 4, [0x66, 0x74, 0x79, 0x70])) {
    const brands = isoBrands(bytes);
    if (brands.some((brand) => ['avif', 'avis'].includes(brand))) return 'image/avif';
    if (brands.some((brand) => ['heic', 'heix', 'hevc', 'hevx'].includes(brand)))
      return 'image/heic';
    if (brands.some((brand) => ['mif1', 'msf1'].includes(brand))) return 'image/heif';
  }
  return null;
}

function isoBrands(bytes: Uint8Array): string[] {
  if (bytes.length < 16) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = view.getUint32(0);
  let header = 8;
  if (size === 1) {
    if (bytes.length < 24) return [];
    const extended = view.getBigUint64(8);
    if (extended > BigInt(bytes.length)) return [];
    size = Number(extended);
    header = 16;
  }
  if (size === 0) size = bytes.length;
  if (size < header + 8 || size > bytes.length || (size - header) % 4 !== 0) return [];
  const brands = [String.fromCharCode(...bytes.subarray(header, header + 4))];
  for (let offset = header + 8; offset + 4 <= size; offset += 4)
    brands.push(String.fromCharCode(...bytes.subarray(offset, offset + 4)));
  return brands;
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.byteLength < 24 || !matches(bytes, 12, [0x49, 0x48, 0x44, 0x52])) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const JPEG_START_OF_FRAME = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  let offset = 2;
  while (offset + 3 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset];
    offset++;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    const lengthHigh = bytes[offset];
    const lengthLow = bytes[offset + 1];
    if (lengthHigh === undefined || lengthLow === undefined) return null;
    const segmentLength = (lengthHigh << 8) | lengthLow;
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) return null;
    if (JPEG_START_OF_FRAME.has(marker)) {
      if (segmentLength < 7) return null;
      const heightHigh = bytes[offset + 3];
      const heightLow = bytes[offset + 4];
      const widthHigh = bytes[offset + 5];
      const widthLow = bytes[offset + 6];
      if (
        heightHigh === undefined ||
        heightLow === undefined ||
        widthHigh === undefined ||
        widthLow === undefined
      ) {
        return null;
      }
      return {
        width: (widthHigh << 8) | widthLow,
        height: (heightHigh << 8) | heightLow,
      };
    }
    offset += segmentLength;
  }
  return null;
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number): number | null {
  const first = bytes[offset];
  const second = bytes[offset + 1];
  const third = bytes[offset + 2];
  return first === undefined || second === undefined || third === undefined
    ? null
    : first | (second << 8) | (third << 16);
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.byteLength < 30) return null;
  if (matches(bytes, 12, [0x56, 0x50, 0x38, 0x58])) {
    const width = readUint24LittleEndian(bytes, 24);
    const height = readUint24LittleEndian(bytes, 27);
    return width === null || height === null ? null : { width: width + 1, height: height + 1 };
  }
  if (matches(bytes, 12, [0x56, 0x50, 0x38, 0x4c]) && bytes[20] === 0x2f) {
    const first = bytes[21];
    const second = bytes[22];
    const third = bytes[23];
    const fourth = bytes[24];
    if (
      first === undefined ||
      second === undefined ||
      third === undefined ||
      fourth === undefined
    ) {
      return null;
    }
    return {
      width: 1 + first + ((second & 0x3f) << 8),
      height: 1 + (second >> 6) + (third << 2) + ((fourth & 0x0f) << 10),
    };
  }
  if (matches(bytes, 12, [0x56, 0x50, 0x38, 0x20]) && matches(bytes, 23, [0x9d, 0x01, 0x2a])) {
    const widthLow = bytes[26];
    const widthHigh = bytes[27];
    const heightLow = bytes[28];
    const heightHigh = bytes[29];
    if (
      widthLow === undefined ||
      widthHigh === undefined ||
      heightLow === undefined ||
      heightHigh === undefined
    ) {
      return null;
    }
    return {
      width: (widthLow | (widthHigh << 8)) & 0x3fff,
      height: (heightLow | (heightHigh << 8)) & 0x3fff,
    };
  }
  return null;
}

function headerDimensions(bytes: Uint8Array, type: SupportedRasterType): ImageDimensions | null {
  switch (type) {
    case 'image/png':
      return pngDimensions(bytes);
    case 'image/jpeg':
      return jpegDimensions(bytes);
    case 'image/webp':
      return webpDimensions(bytes);
    default:
      return isoDimensions(bytes);
  }
}

/** Bounded ISO-BMFF metadata walk, before invoking the HEIF/AVIF decoder. */
function isoDimensions(bytes: Uint8Array): ImageDimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let largest: ImageDimensions | null = null;
  let budget = 2048;
  const walk = (start: number, end: number, depth: number): void => {
    if (depth > 6) return;
    for (let offset = start; offset + 8 <= end && budget-- > 0;) {
      let size = view.getUint32(offset);
      const kind = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) return;
        const extended = view.getBigUint64(offset + 8);
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return;
        size = Number(extended);
        header = 16;
      }
      if (size === 0) size = end - offset;
      if (size < header) return;
      const limit = Math.min(end, offset + size);
      if (kind === 'ispe' && size >= header + 12 && offset + header + 12 <= end) {
        const candidate = {
          width: view.getUint32(offset + header + 4),
          height: view.getUint32(offset + header + 8),
        };
        if (largest === null || candidate.width * candidate.height > largest.width * largest.height)
          largest = candidate;
      } else if (kind === 'meta' || kind === 'iprp' || kind === 'ipco') {
        walk(offset + header + (kind === 'meta' ? 4 : 0), limit, depth + 1);
      }
      if (offset + size > end) return;
      offset += size;
    }
  };
  walk(0, bytes.length, 0);
  return largest;
}

export function readRasterMetadata(
  bytes: Uint8Array,
): { type: SupportedRasterType; dimensions: ImageDimensions } | null {
  const type = detectedType(bytes);
  if (type === null) return null;
  const dimensions = headerDimensions(bytes, type);
  return dimensions === null ? null : { type, dimensions };
}
