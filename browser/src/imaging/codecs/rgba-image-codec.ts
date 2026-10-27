import type { ImageAsset } from '../../domain/document';
import type { RgbaBackendInput } from '../engines/scanic-backend-contract';

export type EncodedRasterType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface RgbaEncodeOptions {
  readonly type: EncodedRasterType;
  readonly quality?: number;
}

export interface RgbaImageCodec {
  decode(asset: ImageAsset, signal: AbortSignal): Promise<RgbaBackendInput>;
  encode(input: RgbaBackendInput, options: RgbaEncodeOptions, signal: AbortSignal): Promise<Blob>;
}
