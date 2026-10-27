import { recordPipelineTiming } from '../pipeline-timing';
import type { EditRecipe, ImageAsset } from '../../domain/document';
import type { ScannerEngine } from '../contracts/scanner-engine';
import type { RgbaBackendInput } from '../engines/scanic-backend-contract';
import type { LocalRestorationAnalysis, LocalRestorationClient } from './local-restoration-client';
import type { PageRestorationState } from '../../features/scanner/background-page-processor';

/** Analysis sees an untouched small crop; the final pixels are encoded only after all operations. */
export async function renderAnalyzedPage(
  engine: ScannerEngine,
  original: ImageAsset,
  recipe: EditRecipe,
  signal: AbortSignal,
  options: {
    readonly analyzer?: Pick<LocalRestorationClient, 'analyze'>;
    readonly analysis?: LocalRestorationAnalysis;
    readonly sourcePixels?: RgbaBackendInput;
    readonly analysisKey?: string;
  } = {},
) {
  const analyzer =
    options.analyzer ?? (engine.analyze ? { analyze: engine.analyze.bind(engine) } : undefined);
  let analysis = options.analysis;
  let restoration: PageRestorationState = { kind: 'local' };
  const needsClassifier =
    recipe.filter.mode !== 'enhanced-color' &&
    recipe.filter.mode !== 'original' &&
    recipe.filter.mode !== 'shadow-removal';
  const pixels = options.sourcePixels === undefined ? {} : { sourcePixels: options.sourcePixels };
  if (needsClassifier && analysis === undefined && analyzer?.analyze !== undefined) {
    try {
      const request = {
        original,
        orientation: 0 as const,
        recipe: {
          ...recipe,
          rotation: 0 as const,
          filter: {
            mode: 'original' as const,
            presetVersion: 'classifier-rough-v1',
            parameters: {},
          },
        },
        maximumOutputLongSide: 720,
        preserveOutputPixels: true,
        ...pixels,
      };
      const cropStarted = performance.now();
      const raw =
        engine.renderPixels === undefined
          ? (await engine.render(request, signal)).transientRgba
          : await engine.renderPixels(request, signal);
      recordPipelineTiming({ crop720: performance.now() - cropStarted });
      if (raw === undefined) throw new Error('Raw analysis crop unavailable.');
      analysis = await analyzer.analyze(
        { kind: 'rgba-frame', ...raw },
        signal,
        options.analysisKey === undefined ? {} : { analysisKey: options.analysisKey },
      );
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      restoration = { kind: 'fallback', reason: 'failed' };
    }
  }
  if (needsClassifier) recordPipelineTiming({ ...analysis?.timings });
  const variant = await engine.render(
    {
      original,
      orientation: 0,
      recipe,
      maximumOutputLongSide: 3000,
      preserveOutputPixels: false,
      createThumbnail: true,
      ...pixels,
      ...(options.sourcePixels === undefined ? {} : { consumeSourcePixels: true }),
      ...(analysis === undefined ? {} : { analysis }),
    },
    signal,
  );
  if (needsClassifier && analysis !== undefined)
    restoration = {
      kind: 'applied',
      stages: analysis.stages,
      classifierModel: analysis.classifierModel,
      provider: 'docscan-cpp-wasm@9',
      warnings: analysis.warnings,
    };
  return {
    variant,
    restoration,
    ...(analysis === undefined ? {} : { analysis }),
  };
}
