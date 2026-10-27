import type { RestorationStage } from './restoration-policy';

export type AppliedRestorationStage = Exclude<RestorationStage, 'finger-segmentation' | 'dewarp'>;

export type RestorationWarning =
  'retake-finger' | 'retake-curved' | 'unsupported-moire' | 'retake-blur';
