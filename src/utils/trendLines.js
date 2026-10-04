// Store dates/prices, never screen pixels or a bar's moving array index.
export function candleTimestamp(time) {
  if (typeof time === 'number') return time;
  if (typeof time === 'string') return Date.parse(time) / 1000;
  if (time && typeof time === 'object') return Date.UTC(time.year, time.month - 1, time.day) / 1000;
  return NaN;
}

export function timeAtLogical(candles, logical) {
  if (!candles.length || !Number.isFinite(logical)) return null;
  // Snap to actual trading dates, including shortened holiday weeks.
  const index = Math.max(0, Math.min(candles.length - 1, Math.round(logical)));
  const time = candleTimestamp(candles[index].time);
  return Number.isFinite(time) ? time : null;
}

export function logicalAtTime(candles, time) {
  if (!candles.length || !Number.isFinite(time)) return null;
  let low = 0;
  let high = candles.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const value = candleTimestamp(candles[mid].time);
    if (value === time) return mid;
    if (value < time) low = mid + 1;
    else high = mid - 1;
  }
  // An endpoint outside the loaded history is hidden, not moved to a new date.
  if (low === 0 || low === candles.length) return null;
  const before = candleTimestamp(candles[low - 1].time);
  const after = candleTimestamp(candles[low].time);
  return low - 1 + (time - before) / (after - before);
}

export function cleanTrendLines(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, lines] of Object.entries(value).slice(0, 90)) {
    if (!/^.{1,30}:(1m|3m|5m|15m|30m|60m|day|week|month)$/.test(key) || !Array.isArray(lines)) continue;
    result[key] = lines.slice(0, 100).flatMap((line) => {
      if (!line?.id || ![line.start?.time, line.start?.price, line.end?.time, line.end?.price].every(Number.isFinite)) return [];
      return [{
        id: String(line.id).slice(0, 100),
        start: { time: line.start.time, price: line.start.price },
        end: { time: line.end.time, price: line.end.price },
        width: [1, 2, 3].includes(line.width) ? line.width : 1,
      }];
    });
  }
  return result;
}
