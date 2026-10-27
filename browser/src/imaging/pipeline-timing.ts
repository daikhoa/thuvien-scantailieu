/** Numeric durations only, bounded to the last 24 measurements; disabled in production by default. */
const enabled = import.meta.env.DEV || import.meta.env.VITE_SCAN_TIMINGS === 'true';
export type PipelineTimings = Partial<
  Record<
    | 'capture'
    | 'frozenDetection'
    | 'crop720'
    | 'classifier'
    | 'qualityMetrics'
    | 'warp3000'
    | 'restorationFilter'
    | 'jpegEncode'
    | 'total',
    number
  >
>;
const recent: PipelineTimings[] = [];
export function recordPipelineTiming(timings: PipelineTimings): void {
  if (!enabled) return;
  recent.push({ ...timings });
  if (recent.length > 24) recent.shift();
}
export function pipelineTimings(): readonly PipelineTimings[] {
  return recent.map((value) => ({ ...value }));
}
