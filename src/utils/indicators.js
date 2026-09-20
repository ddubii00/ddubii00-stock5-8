export function calculateMACD(ohlcv, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (!ohlcv || ohlcv.length < slowPeriod + signalPeriod) return [];

  const closes = ohlcv.map(d => d.close);

  function ema(data, period) {
    const k = 2 / (period + 1);
    const result = new Array(data.length).fill(null);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += data[i];
    result[period - 1] = sum / period;
    for (let i = period; i < data.length; i++) {
      result[i] = data[i] * k + result[i - 1] * (1 - k);
    }
    return result;
  }

  const emaFast = ema(closes, fastPeriod);
  const emaSlow = ema(closes, slowPeriod);

  const macdLine = closes.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null
  );

  const validMacdStartIdx = macdLine.findIndex(v => v !== null);
  const validMacd = macdLine.slice(validMacdStartIdx).map(v => v ?? 0);
  const signalRaw = ema(validMacd, signalPeriod);

  const result = [];
  for (let i = 0; i < ohlcv.length; i++) {
    const macd = macdLine[i];
    const sigIdx = i - validMacdStartIdx;
    const signal = sigIdx >= 0 ? signalRaw[sigIdx] : null;
    const histogram = macd !== null && signal !== null ? macd - signal : null;

    result.push({
      time: ohlcv[i].time,
      macd,
      signal,
      histogram,
      color: histogram !== null ? (histogram >= 0 ? '#ef5350' : '#1565c0') : 'transparent',
    });
  }

  return result;
}

export function calculateIchimoku(ohlcv, conv = 9, base = 26, spanB = 52, disp = 26) {
  const n = ohlcv.length;
  if (n < spanB) return [];

  function midpoint(idx, period) {
    if (idx < period - 1) return null;
    let hi = -Infinity, lo = Infinity;
    for (let i = idx - period + 1; i <= idx; i++) {
      hi = Math.max(hi, ohlcv[i].high);
      lo = Math.min(lo, ohlcv[i].low);
    }
    return (hi + lo) / 2;
  }

  const out = ohlcv.map((_, i) => ({
    tenkan: midpoint(i, conv),
    kijun: midpoint(i, base),
    chikou: null,
    senkouA: null,
    senkouB: null,
  }));

  for (let i = 0; i < n; i++) {
    const target = i - disp;
    if (target >= 0) out[target].chikou = ohlcv[i].close;
  }

  for (let i = 0; i < n; i++) {
    const target = i + disp;
    if (target < n) {
      const t = out[i].tenkan, k = out[i].kijun;
      out[target].senkouA = t !== null && k !== null ? (t + k) / 2 : null;
      out[target].senkouB = midpoint(i, spanB);
    }
  }

  return out;
}

/** Simple Moving Average (returns array of {time, value}) */
export function calculateMA(ohlcv, period) {
  const result = [];
  for (let i = 0; i < ohlcv.length; i++) {
    if (i < period - 1) { result.push({ time: ohlcv[i].time, value: null }); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += ohlcv[j].close;
    result.push({ time: ohlcv[i].time, value: sum / period });
  }
  return result;
}

/** Bollinger Bands: 20-period SMA with upper/lower bands at two standard deviations. */
export function calculateBollingerBands(ohlcv, period = 20, multiplier = 2) {
  return (ohlcv || []).map((candle, index) => {
    if (index < period - 1) return { time: candle.time, middle: null, upper: null, lower: null };
    const closes = ohlcv.slice(index - period + 1, index + 1).map(item => Number(item.close));
    const middle = closes.reduce((sum, value) => sum + value, 0) / period;
    const variance = closes.reduce((sum, value) => sum + (value - middle) ** 2, 0) / period;
    const deviation = Math.sqrt(variance);
    return { time: candle.time, middle, upper: middle + multiplier * deviation, lower: middle - multiplier * deviation };
  });
}

/** Build a Map<time, value> for fast lookup */
export function buildTimeMap(arr) {
  const m = new Map();
  arr.forEach(d => { if (d.value != null) m.set(typeof d.time === 'string' ? d.time : String(d.time), d.value); });
  return m;
}
