import type { DocumentQualityProfile } from '../analysis/document-quality';
import type { LocalRestorationAnalysis, RestorationStrengths } from './local-restoration-client';
import { DOCUMENT_DEFECT_LABELS, type DocumentDefectScores } from './restoration-policy';
import type { AppliedRestorationStage, RestorationWarning } from './restoration-types';

const unit = (value: number) => Math.max(0, Math.min(1, value));

/** Classifier identifies defects; measured evidence bounds each correction's strength. */
export function createAdaptiveRestorationPlan(
  scores: DocumentDefectScores,
  quality: DocumentQualityProfile,
): LocalRestorationAnalysis {
  for (const label of DOCUMENT_DEFECT_LABELS) {
    if (!Number.isFinite(scores[label]) || scores[label] < 0 || scores[label] > 1)
      throw new RangeError('Invalid classifier score.');
  }
  const protectColor = scores.colorDocument >= 0.6 || quality.stages.protectColor;
  const safeHighlights = 1 - unit(quality.clipping.highlightRatio / 0.55);
  const blurEvidence = unit((18 - quality.detail.edgeScore) / 18);
  const strengths: RestorationStrengths = {
    shadow:
      Math.max(
        unit((scores.shadow - 0.35) / 0.55),
        unit((quality.illumination.range - 45) / 90) * 0.4,
      ) *
      unit((quality.illumination.range - 18) / 80) *
      safeHighlights,
    lift:
      unit((215 - quality.brightness.mean) / 140) * safeHighlights * (protectColor ? 0.15 : 0.65),
    contrast:
      unit((scores.lowContrast - 0.3) / 0.6) *
      unit((28 - quality.brightness.contrast) / 28) *
      unit(quality.detail.edgeScore / 2) *
      (protectColor ? 0.3 : 0.6),
    sharpen:
      quality.detail.kind === 'high'
        ? 0
        : unit((scores.blur - 0.3) / 0.6) * blurEvidence * (protectColor ? 0.4 : 0.8),
    smooth:
      unit((scores.moire - 0.45) / 0.5) *
      unit(((quality.detail.periodicRatio ?? 0) - 0.03) / 0.12) *
      (quality.detail.kind === 'high' ? 0.08 : 0.25),
  };
  const stages: AppliedRestorationStage[] = [];
  if (strengths.smooth > 0) stages.push('demoire');
  if (strengths.shadow > 0) stages.push('deshadow');
  if (strengths.lift > 0 || strengths.contrast > 0) stages.push('appearance');
  if (strengths.sharpen > 0) stages.push('deblur');
  const warnings: RestorationWarning[] = [];
  if (scores.finger >= 0.75) warnings.push('retake-finger');
  if (scores.curved >= 0.75) warnings.push('retake-curved');
  if (scores.moire >= 0.75 && (quality.detail.periodicRatio ?? 0) > 0.05)
    warnings.push('unsupported-moire');
  if (scores.blur >= 0.85 && blurEvidence >= 0.7) warnings.push('retake-blur');
  return {
    kind: 'analysis',
    classifierModel: 'document-defects@cord-v2-bootstrap-2026-10-18',
    stages,
    warnings,
    protectColor,
    quality,
    strengths,
  };
}
