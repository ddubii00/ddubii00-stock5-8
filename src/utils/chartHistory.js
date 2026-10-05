export const MA_PERIODS = [5, 10, 20, 60, 120, 200];
const MA_WARMUP_BARS = Math.max(...MA_PERIODS) - 1;
const MAX_VISIBLE_BARS = 2000;
export const MAX_CANDLE_HISTORY = MAX_VISIBLE_BARS + MA_WARMUP_BARS;

export function candleHistoryLimit(interval, visibleBars) {
  const visible = Math.min(MAX_VISIBLE_BARS, Math.max(10, Math.floor(Number(visibleBars) || 120)));
  const minimum = ['week', 'month'].includes(interval) ? 240 : 300;
  // Keep the displayed range unchanged; earlier bars are only indicator warm-up.
  return Math.max(minimum, visible + MA_WARMUP_BARS);
}
