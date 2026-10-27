import { detectStillCorners } from './still-corner-detector';
import { SCANIC_ML_ASSET_BASE } from './scanic-ml-assets';
import { Scanner, type DetectionOptions, type ScannerResult } from 'scanic';
import { ScannerEngineError } from './scanner-engine-error';

export type ScanicDetectorKind = 'ml';

export const SCANIC_ML_MIN_SCORE = 0.5;
export const SCANIC_CLASSICAL_MIN_CONFIDENCE = 0.72;

const COMMON_OPTIONS = {
  mode: 'detect',
  output: 'imagedata',
  debug: false,
  maxProcessingDimension: 8192,
} as const satisfies DetectionOptions;

const MODEL_SIDE = 224;
type DetectorCanvas = OffscreenCanvas | HTMLCanvasElement;
type DetectorContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function createSurface(width: number, height: number): DetectorCanvas {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context2d(canvas: DetectorCanvas): DetectorContext {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) throw new ScannerEngineError('unavailable');
  return context;
}

function detectorOptions(): DetectionOptions {
  return {
    ...COMMON_OPTIONS,
    detector: 'ml',
    ml: {
      assetBaseUrl: SCANIC_ML_ASSET_BASE,
      numThreads: 1,
      minScore: SCANIC_ML_MIN_SCORE,
      modelFetchTimeoutMs: 30_000,
    },
  };
}

export interface ScanicDetectorResult extends ScannerResult {
  readonly detector: ScanicDetectorKind;
}

type ScanicScanner = Pick<Scanner, 'initialize' | 'scan'>;
type ScanicScannerFactory = (options: DetectionOptions) => ScanicScanner;

/** One ML session per realm. Recovery must destroy the worker: Scanic caches ONNX globally. */
export class ScanicDetectorRuntime {
  private readonly scanner: ScanicScanner;
  private surfaces: {
    source: DetectorCanvas;
    sourceContext: DetectorContext;
    model: DetectorCanvas;
    modelContext: DetectorContext;
  } | null = null;
  private readonly inputData = new Float32Array(MODEL_SIDE * MODEL_SIDE * 3);

  constructor(createScanner: ScanicScannerFactory = (options) => new Scanner(options)) {
    this.scanner = createScanner(detectorOptions());
  }

  async initialize(): Promise<void> {
    await this.scanner.initialize();
  }

  private prepareInput(image: ImageData): Float32Array {
    if (this.surfaces === null) {
      const source = createSurface(image.width, image.height);
      const model = createSurface(MODEL_SIDE, MODEL_SIDE);
      this.surfaces = {
        source,
        sourceContext: context2d(source),
        model,
        modelContext: context2d(model),
      };
    }
    const { source, sourceContext, modelContext } = this.surfaces;
    if (source.width !== image.width) source.width = image.width;
    if (source.height !== image.height) source.height = image.height;
    sourceContext.putImageData(image, 0, 0);
    modelContext.clearRect(0, 0, MODEL_SIDE, MODEL_SIDE);
    modelContext.imageSmoothingEnabled = true;
    modelContext.imageSmoothingQuality = 'medium';
    modelContext.drawImage(source, 0, 0, image.width, image.height, 0, 0, MODEL_SIDE, MODEL_SIDE);
    const { data } = modelContext.getImageData(0, 0, MODEL_SIDE, MODEL_SIDE);
    // Match Scanic 1.6.0's NHWC RGB normalization and resize exactly. Its default
    // preprocessing allocates two canvases per frame without explicitly releasing them.
    for (let rgba = 0, rgb = 0; rgba < data.length; rgba += 4, rgb += 3) {
      this.inputData[rgb] = ((data[rgba] ?? 0) / 255 - 0.485) / 0.229;
      this.inputData[rgb + 1] = ((data[rgba + 1] ?? 0) / 255 - 0.456) / 0.224;
      this.inputData[rgb + 2] = ((data[rgba + 2] ?? 0) / 255 - 0.406) / 0.225;
    }
    return this.inputData;
  }

  async scan(image: ImageData, mode?: 'still'): Promise<ScanicDetectorResult> {
    // inputData is supported by the pinned Scanic JS implementation but omitted
    // from its public typings. Each backend serializes inference in its owned realm.
    const scan = async (input: ImageData): Promise<ScannerResult> => {
      const defaults = detectorOptions();
      const options = {
        ...defaults,
        ml: {
          ...defaults.ml,
          minScore: mode === 'still' ? 0 : SCANIC_ML_MIN_SCORE,
          inputData: this.prepareInput(input),
        },
      };
      return this.scanner.scan(input, options);
    };
    const result = mode === 'still' ? await detectStillCorners(image, scan) : await scan(image);
    return { ...result, detector: 'ml' };
  }
}
