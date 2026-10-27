import type { CropRegion, EditRecipe, FilterMode, QuarterTurn } from '../../domain/document';

export const DEFAULT_DOCUMENT_FILTER: FilterMode = 'enhanced-color';

export interface DocumentFilterOption {
  readonly mode: FilterMode;
  readonly label: string;
  readonly description: string;
}

export const DOCUMENT_FILTERS: readonly DocumentFilterOption[] = [
  { mode: 'original', label: 'Gốc', description: 'Chỉ cắt và làm thẳng' },
  {
    mode: 'enhanced-color',
    label: 'Tăng cường',
    description: 'Bù bóng theo vùng, làm rõ chữ và giữ màu nền',
  },
  {
    mode: 'shadow-removal',
    label: 'Khử bóng AI',
    description: 'Model 6 MB, dành cho bóng rộng; kiểm tra lại màu nền',
  },
  { mode: 'ocr-color', label: 'Tự động', description: 'Làm nét chữ, giữ màu' },
  { mode: 'grayscale', label: 'Xám', description: 'Nền trung tính, chữ rõ' },
  { mode: 'black-and-white', label: 'Đen trắng', description: 'Tách chữ khỏi nền' },
];

function presetVersion(mode: FilterMode): string {
  if (mode === 'shadow-removal') return 'gcnet-2eb69a0a-field-v1';
  if (mode === 'enhanced-color') return 'enhanced-color-v6-adaptive';
  return mode === 'original'
    ? 'original-v1'
    : mode === 'black-and-white'
      ? 'black-and-white-v5'
      : `${mode}-v7`;
}

export function createDocumentRecipe(
  crop: CropRegion,
  mode: FilterMode = DEFAULT_DOCUMENT_FILTER,
  rotation: QuarterTurn = 0,
): EditRecipe {
  return {
    version: 1,
    crop,
    rotation,
    dewarp: { mode: 'perspective-only' },
    filter: { mode, presetVersion: presetVersion(mode), parameters: {} },
  };
}

export function recipeWithFilter(recipe: EditRecipe, mode: FilterMode): EditRecipe {
  return {
    ...recipe,
    filter: { mode, presetVersion: presetVersion(mode), parameters: {} },
  };
}

export function documentFilterLabel(mode: FilterMode): string {
  return DOCUMENT_FILTERS.find((option) => option.mode === mode)?.label ?? 'Tự động';
}
