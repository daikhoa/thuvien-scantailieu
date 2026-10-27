export const DOCUMENT_DEFECT_LABELS = [
  'shadow',
  'curved',
  'blur',
  'moire',
  'finger',
  'lowContrast',
  'colorDocument',
] as const;

export type DocumentDefectLabel = (typeof DOCUMENT_DEFECT_LABELS)[number];

export type DocumentDefectScores = Readonly<Record<DocumentDefectLabel, number>>;

export type RestorationStage =
  'finger-segmentation' | 'dewarp' | 'deshadow' | 'demoire' | 'deblur' | 'appearance';

export interface RestorationEvidence {
  readonly illuminationRange: number;
  readonly highlightRatio: number;
  readonly detail: 'low' | 'medium' | 'high';
}

export type RestorationDecision =
  | { readonly kind: 'local'; readonly protectColor: boolean }
  | {
      readonly kind: 'enhance';
      readonly stages: readonly RestorationStage[];
      readonly protectColor: boolean;
    };

interface RestorationPolicyInput {
  readonly scores: DocumentDefectScores;
  readonly evidence: RestorationEvidence;
}

const HIGH_CONFIDENCE = 0.75;
const MEDIUM_CONFIDENCE = 0.45;
const COLOR_PROTECTION_CONFIDENCE = 0.6;
const UNEVEN_ILLUMINATION_RANGE = 18;
const MAXIMUM_CORRECTABLE_HIGHLIGHT_RATIO = 0.55;

function validateProbability(value: number, label: DocumentDefectLabel): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`Invalid ${label} probability.`);
  }
}

function validateEvidence(evidence: RestorationEvidence): void {
  if (!Number.isFinite(evidence.illuminationRange) || evidence.illuminationRange < 0) {
    throw new RangeError('Invalid illumination range.');
  }
  if (
    !Number.isFinite(evidence.highlightRatio) ||
    evidence.highlightRatio < 0 ||
    evidence.highlightRatio > 1
  ) {
    throw new RangeError('Invalid highlight ratio.');
  }
}

export function decideRestorationPolicy({
  scores,
  evidence,
}: RestorationPolicyInput): RestorationDecision {
  for (const label of DOCUMENT_DEFECT_LABELS) validateProbability(scores[label], label);
  validateEvidence(evidence);

  const stages: RestorationStage[] = [];
  if (scores.finger >= HIGH_CONFIDENCE) stages.push('finger-segmentation');
  if (scores.curved >= HIGH_CONFIDENCE) stages.push('dewarp');
  if (
    scores.shadow >= HIGH_CONFIDENCE ||
    (scores.shadow >= MEDIUM_CONFIDENCE &&
      evidence.illuminationRange >= UNEVEN_ILLUMINATION_RANGE &&
      evidence.highlightRatio < MAXIMUM_CORRECTABLE_HIGHLIGHT_RATIO)
  ) {
    stages.push('deshadow');
  }
  if (scores.moire >= HIGH_CONFIDENCE) stages.push('demoire');
  if (
    scores.blur >= HIGH_CONFIDENCE ||
    (scores.blur >= MEDIUM_CONFIDENCE && evidence.detail === 'low')
  ) {
    stages.push('deblur');
  }
  if (scores.lowContrast >= HIGH_CONFIDENCE) stages.push('appearance');

  const protectColor = scores.colorDocument >= COLOR_PROTECTION_CONFIDENCE;
  return stages.length === 0
    ? { kind: 'local', protectColor }
    : { kind: 'enhance', stages, protectColor };
}
