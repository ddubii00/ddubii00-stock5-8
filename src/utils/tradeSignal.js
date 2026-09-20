// Port of ddubii00/ddubii00-stock1/signal_engine.py.
// Keep this module mathematically aligned with stock1 so the same OHLCV history
// produces the same partial-buy/partial-sell recommendation.

function sma(values, period) {
  const result = new Array(values.length).fill(null);
  if (period <= 0) return result;
  let running = 0;
  for (let index = 0; index < values.length; index += 1) {
    running += values[index];
    if (index >= period) running -= values[index - period];
    if (index >= period - 1) result[index] = running / period;
  }
  return result;
}

function ema(values, period) {
  const result = new Array(values.length).fill(null);
  if (values.length < period) return result;
  const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = seed;
  const multiplier = 2 / (period + 1);
  let previous = seed;
  for (let index = period; index < values.length; index += 1) {
    previous = ((values[index] - previous) * multiplier) + previous;
    result[index] = previous;
  }
  return result;
}

function midpoint(highs, lows, period) {
  const result = new Array(highs.length).fill(null);
  for (let index = period - 1; index < highs.length; index += 1) {
    const windowHigh = Math.max(...highs.slice(index - period + 1, index + 1));
    const windowLow = Math.min(...lows.slice(index - period + 1, index + 1));
    result[index] = (windowHigh + windowLow) / 2;
  }
  return result;
}

function crossedAbove(left, right, index = -1) {
  const current = index >= 0 ? index : left.length + index;
  const previous = current - 1;
  if (previous < 0 || current < 0) return false;
  const values = [left[previous], right[previous], left[current], right[current]];
  return values.every(value => value !== null && value !== undefined)
    && left[previous] <= right[previous]
    && left[current] > right[current];
}

function crossedBelow(left, right, index = -1) {
  const current = index >= 0 ? index : left.length + index;
  const previous = current - 1;
  if (previous < 0 || current < 0) return false;
  const values = [left[previous], right[previous], left[current], right[current]];
  return values.every(value => value !== null && value !== undefined)
    && left[previous] >= right[previous]
    && left[current] < right[current];
}

function percentile(values, ratio) {
  const ordered = values.filter(value => value !== null && value !== undefined).sort((a, b) => a - b);
  if (!ordered.length) return null;
  const position = (ordered.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, ordered.length - 1);
  const fraction = position - lower;
  return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction;
}

function linearPredictions(values, futureCount) {
  const count = values.length;
  if (count < 2) return null;
  const xMean = (count - 1) / 2;
  const yMean = values.reduce((sum, value) => sum + value, 0) / count;
  let denominator = 0;
  let numerator = 0;
  for (let index = 0; index < count; index += 1) {
    denominator += (index - xMean) ** 2;
    numerator += (index - xMean) * (values[index] - yMean);
  }
  if (!denominator) return null;
  const slope = numerator / denominator;
  const intercept = yMean - slope * xMean;
  return {
    slope,
    predicted: Array.from({ length: futureCount }, (_, index) => intercept + slope * (count + index)),
  };
}

function dmi(highs, lows, closes, period = 14) {
  const plusDm = new Array(closes.length).fill(0);
  const minusDm = new Array(closes.length).fill(0);
  const trueRange = new Array(closes.length).fill(0);
  for (let index = 1; index < closes.length; index += 1) {
    const upMove = highs[index] - highs[index - 1];
    const downMove = lows[index - 1] - lows[index];
    plusDm[index] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDm[index] = downMove > upMove && downMove > 0 ? downMove : 0;
    trueRange[index] = Math.max(
      highs[index] - lows[index],
      Math.abs(highs[index] - closes[index - 1]),
      Math.abs(lows[index] - closes[index - 1]),
    );
  }
  const trSum = sma(trueRange, period);
  const plusSum = sma(plusDm, period);
  const minusSum = sma(minusDm, period);
  const plusDi = new Array(closes.length).fill(null);
  const minusDi = new Array(closes.length).fill(null);
  for (let index = 0; index < closes.length; index += 1) {
    if (trSum[index]) {
      plusDi[index] = 100 * plusSum[index] / trSum[index];
      minusDi[index] = 100 * minusSum[index] / trSum[index];
    }
  }
  return { plusDi, minusDi };
}

function obv(closes, volumes) {
  const result = new Array(closes.length).fill(0);
  for (let index = 1; index < closes.length; index += 1) {
    if (closes[index] > closes[index - 1]) result[index] = result[index - 1] + volumes[index];
    else if (closes[index] < closes[index - 1]) result[index] = result[index - 1] - volumes[index];
    else result[index] = result[index - 1];
  }
  return result;
}

function signal(group, name, weight) {
  return { group, name, weight };
}

function recommendedQuantity(totalQuantity, percentage, action) {
  if (totalQuantity <= 0 || percentage <= 0 || action === 'HOLD') return 0;
  const quantity = Math.max(1, Math.ceil(totalQuantity * percentage / 100));
  return action === 'PARTIAL_SELL' ? Math.min(totalQuantity, quantity) : quantity;
}

export function finalizeTradeSignalPercentages(sellPercentage, rawBuyPercentage, track) {
  const sell = Math.min(100, sellPercentage);
  const rawBuy = Math.min(100, rawBuyPercentage);
  const buy = rawBuy * (track === 'TRACK_2' ? 0.5 : 1);
  if (sell > buy) return { action: 'PARTIAL_SELL', percentage: sell, sellPercentage: sell, buyPercentage: buy };
  if (buy > sell) return { action: 'PARTIAL_BUY', percentage: buy, sellPercentage: sell, buyPercentage: buy };
  return { action: 'HOLD', percentage: 0, sellPercentage: sell, buyPercentage: buy };
}

function cleanHistoryRows(history) {
  return (history || [])
    .filter(item => ['open', 'high', 'low', 'close', 'volume'].every(key => item?.[key] !== null && item?.[key] !== undefined && Number.isFinite(Number(item[key]))))
    .map(item => ({
      date: String(item.date ?? item.time ?? ''),
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.close),
      volume: Number(item.volume),
    }));
}

export function analyzeTradeSignal(history, totalQuantity = 0) {
  const cleanHistory = cleanHistoryRows(history);
  if (cleanHistory.length < 120) throw new Error('신호 계산에는 최소 120거래일의 일봉 데이터가 필요합니다.');

  const opens = cleanHistory.map(item => item.open);
  const highs = cleanHistory.map(item => item.high);
  const lows = cleanHistory.map(item => item.low);
  const closes = cleanHistory.map(item => item.close);
  const volumes = cleanHistory.map(item => item.volume);

  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macd = closes.map((_, index) => (ema12[index] === null || ema26[index] === null ? null : ema12[index] - ema26[index]));
  const macdValues = macd.filter(value => value !== null);
  const signalCompact = ema(macdValues, 9);
  const macdSignal = new Array(closes.length).fill(null);
  let compactIndex = 0;
  macd.forEach((value, index) => {
    if (value !== null) {
      macdSignal[index] = signalCompact[compactIndex];
      compactIndex += 1;
    }
  });

  const tenkan = midpoint(highs, lows, 9);
  const kijun = midpoint(highs, lows, 26);
  const spanBBase = midpoint(highs, lows, 52);
  const spanA = new Array(closes.length).fill(null);
  const spanB = new Array(closes.length).fill(null);
  for (let index = 0; index < closes.length - 26; index += 1) {
    if (tenkan[index] !== null && kijun[index] !== null) spanA[index + 26] = (tenkan[index] + kijun[index]) / 2;
    if (spanBBase[index] !== null) spanB[index + 26] = spanBBase[index];
  }

  const { plusDi, minusDi } = dmi(highs, lows, closes);
  const obvValues = obv(closes, volumes);
  const obvMa20 = sma(obvValues, 20);
  const distance = closes.map((close, index) => (ma5[index] === null || ma5[index] === 0 ? null : close / ma5[index] * 100));
  const historicalDistance = distance.slice(Math.max(0, distance.length - 501), -1);
  const distanceP90 = percentile(historicalDistance, 0.90);
  const distanceP10 = percentile(historicalDistance, 0.10);

  const currentCloud = spanB.at(-1);
  const track = ma60.at(-1) !== null && currentCloud !== null && closes.at(-1) > ma60.at(-1) && closes.at(-1) > currentCloud
    ? 'TRACK_1'
    : 'TRACK_2';
  const sellSignals = [];
  const buySignals = [];

  // A/A': two independent early-warning signals.
  if (crossedBelow(macd, macdSignal)) sellSignals.push(signal('A', 'MACD 시그널선 하향 돌파', 5));
  if (crossedAbove(macd, macdSignal)) buySignals.push(signal("A'", 'MACD 시그널선 상향 돌파', 5));
  if (crossedBelow(closes, tenkan)) sellSignals.push(signal('A', '종가 일목 전환선 하향 이탈', 5));
  if (crossedAbove(closes, tenkan)) buySignals.push(signal("A'", '종가 일목 전환선 상향 돌파', 5));

  // B/B': correlated short-term signals are counted once.
  const sellB = [];
  const buyB = [];
  if (crossedBelow(closes, ma5)) sellB.push('5일선 하향 이탈');
  if (crossedAbove(closes, ma5)) buyB.push('5일선 상향 돌파');
  if (ma5.at(-3) !== null && ma5.at(-2) >= ma5.at(-3) && ma5.at(-1) < ma5.at(-2)) sellB.push('5일선 기울기 음전환');
  if (ma5.at(-3) !== null && ma5.at(-2) <= ma5.at(-3) && ma5.at(-1) > ma5.at(-2)) buyB.push('5일선 기울기 양전환');
  if (crossedBelow(ma5, ma10)) sellB.push('5/10 데드크로스');
  if (crossedAbove(ma5, ma10)) buyB.push('5/10 골든크로스');
  if (crossedBelow(tenkan, kijun)) sellB.push('일목 전환선/기준선 데드크로스');
  if (crossedAbove(tenkan, kijun)) buyB.push('일목 전환선/기준선 골든크로스');
  if (sellB.length) sellSignals.push(signal('B', sellB.join(' / '), 10));
  if (buyB.length) buySignals.push(signal("B'", buyB.join(' / '), 10));

  // C/C': correlated medium-term signals are counted once.
  const sellC = [];
  const buyC = [];
  if (crossedBelow(ma5, ma20)) sellC.push('5/20 데드크로스');
  if (crossedAbove(ma5, ma20)) buyC.push('5/20 골든크로스');
  if (crossedBelow(ma20, ma60)) sellC.push('20/60 데드크로스');
  if (crossedAbove(ma20, ma60)) buyC.push('20/60 골든크로스');
  if (ma20.at(-3) !== null && ma20.at(-2) >= ma20.at(-3) && ma20.at(-1) < ma20.at(-2)) sellC.push('20일선 기울기 음전환');
  if (ma20.at(-3) !== null && ma20.at(-2) <= ma20.at(-3) && ma20.at(-1) > ma20.at(-2)) buyC.push('20일선 기울기 양전환');
  const kijunLast4 = kijun.slice(-4);
  if (kijunLast4.every(value => value !== null)) {
    if (kijun.at(-1) < kijun.at(-2) && kijun.at(-2) < kijun.at(-3) && kijun.at(-3) < kijun.at(-4)) sellC.push('일목 기준선 3일 연속 하락');
    if (kijun.at(-1) > kijun.at(-2) && kijun.at(-2) > kijun.at(-3) && kijun.at(-3) > kijun.at(-4)) buyC.push('일목 기준선 3일 연속 상승');
  }
  if (sellC.length) sellSignals.push(signal('C', sellC.join(' / '), 15));
  if (buyC.length) buySignals.push(signal("C'", buyC.join(' / '), 15));

  const averageVolume = volumes.slice(-6, -1).reduce((sum, value) => sum + value, 0) / 5;
  const volumeRatio = averageVolume ? volumes.at(-1) / averageVolume : 0;
  const dayReturn = closes.at(-2) ? (closes.at(-1) / closes.at(-2) - 1) * 100 : 0;
  const negativeFilter = volumeRatio >= 1.30 && closes.at(-1) < opens.at(-1) && dayReturn <= -1.5;
  const positiveThreshold = track === 'TRACK_2' ? 2.0 : 1.30;
  const positiveFilter = volumeRatio >= positiveThreshold && closes.at(-1) > opens.at(-1) && dayReturn >= 1.5;

  // D/D': 60-day regression trendline and prior 60-day support.
  if (closes.length >= 63) {
    const lowRegression = linearPredictions(lows.slice(-62, -2), 2);
    const highRegression = linearPredictions(highs.slice(-62, -2), 2);
    const support = Math.min(...lows.slice(-62, -2));
    if (lowRegression) {
      const { slope, predicted } = lowRegression;
      if (slope > 0 && closes.at(-2) >= predicted[0] && closes.at(-1) < predicted[1] && negativeFilter) {
        sellSignals.push(signal('D', '상승 추세선 하향 이탈(거래량 확인)', 15));
      }
    }
    if (closes.at(-2) >= support && closes.at(-1) < support && negativeFilter) {
      sellSignals.push(signal('D', '최근 60일 지지선 붕괴(거래량 확인)', 15));
    }

    if (highRegression) {
      const { slope, predicted } = highRegression;
      let trendBreakout = slope < 0 && closes.at(-2) <= predicted[0] && closes.at(-1) > predicted[1];
      if (track === 'TRACK_2') {
        const confirmed = linearPredictions(highs.slice(-63, -3), 3);
        if (confirmed) {
          trendBreakout = confirmed.slope < 0 && [0, 1, 2].every(index => closes[closes.length - 3 + index] > confirmed.predicted[index]);
        }
      }
      if (trendBreakout && positiveFilter) buySignals.push(signal("D'", '하락 추세선 상향 돌파(거래량 확인)', 15));
    }

    let supportBounce = lows.at(-1) <= support * 1.01 && closes.at(-1) > support && positiveFilter;
    if (track === 'TRACK_2') {
      supportBounce = [-3, -2, -1].every(index => closes.at(index) > support)
        && lows.at(-3) <= support * 1.01
        && positiveFilter;
    }
    if (supportBounce) buySignals.push(signal("D'", '최근 60일 지지선 반등(거래량 확인)', 15));
  }

  // E/E': independent Ichimoku levels.
  [
    [kijun, '기준선 아래 진입', '기준선 위 복귀'],
    [spanA, '선행스팬1 아래 진입', '선행스팬1 위 복귀'],
    [spanB, '선행스팬2 아래 이탈', '선행스팬2 위 돌파'],
  ].forEach(([line, sellName, buyName]) => {
    if (crossedBelow(closes, line)) sellSignals.push(signal('E', sellName, 5));
    if (crossedAbove(closes, line)) buySignals.push(signal("E'", buyName, 5));
  });
  if (closes.length >= 28) {
    if (closes.at(-2) >= closes.at(-28) && closes.at(-1) < closes.at(-27)) sellSignals.push(signal('E', '후행스팬 역전', 5));
    if (closes.at(-2) <= closes.at(-28) && closes.at(-1) > closes.at(-27)) buySignals.push(signal("E'", '후행스팬 양전환', 5));
  }

  // F/F': lower-confidence supporting indicators.
  if (distanceP90 !== null && distance.at(-2) <= distanceP90 && distanceP90 < distance.at(-1)) {
    sellSignals.push(signal('F', '이격도 최근 2년 상위 10% 진입', 5));
  }
  if (distanceP10 !== null && distance.at(-2) < distanceP10 && distanceP10 <= distance.at(-1)) {
    buySignals.push(signal("F'", '이격도 최근 2년 하위 10% 탈출', 5));
  }
  if (crossedAbove(minusDi, plusDi)) sellSignals.push(signal('F', 'DI-가 DI+ 상향 돌파', 5));
  if (crossedAbove(plusDi, minusDi)) buySignals.push(signal("F'", 'DI+가 DI- 상향 돌파', 5));
  if ([-3, -2, -1].every(index => obvMa20.at(index) !== null && obvValues.at(index) < obvMa20.at(index))
      && obvMa20.at(-4) !== null && obvValues.at(-4) >= obvMa20.at(-4)) {
    sellSignals.push(signal('F', 'OBV 20일선 하향 이탈 3일 지속', 5));
  }
  if (crossedAbove(obvValues, obvMa20)) buySignals.push(signal("F'", 'OBV 20일선 상승 전환', 5));

  const sellPercentageRaw = sellSignals.reduce((sum, item) => sum + item.weight, 0);
  const buyPercentageRaw = buySignals.reduce((sum, item) => sum + item.weight, 0);
  const final = finalizeTradeSignalPercentages(sellPercentageRaw, buyPercentageRaw, track);
  const selectedSignals = final.action === 'PARTIAL_SELL' ? sellSignals : final.action === 'PARTIAL_BUY' ? buySignals : [];
  const quantity = Math.max(0, Math.trunc(Number(totalQuantity) || 0));

  return {
    as_of: cleanHistory.at(-1).date,
    close: closes.at(-1),
    track,
    action: final.action,
    percentage: Number(final.percentage.toFixed(1)),
    recommended_quantity: recommendedQuantity(quantity, final.percentage, final.action),
    total_quantity: quantity,
    sell_percentage: Number(final.sellPercentage.toFixed(1)),
    buy_percentage: Number(final.buyPercentage.toFixed(1)),
    sell_signals: sellSignals,
    buy_signals: buySignals,
    signals: selectedSignals,
    volume_ratio: Number(volumeRatio.toFixed(2)),
    distance_thresholds: {
      p10: distanceP10 === null ? null : Number(distanceP10.toFixed(2)),
      p90: distanceP90 === null ? null : Number(distanceP90.toFixed(2)),
    },
  };
}

export function formatTradeSignalAdvice(value) {
  if (!value) return { tone: 'neutral', text: '신호 계산 불가' };
  const actionLabel = value.action === 'PARTIAL_BUY' ? '부분매수' : value.action === 'PARTIAL_SELL' ? '부분매도' : '관망';
  const tone = value.action === 'PARTIAL_BUY' ? 'buy' : value.action === 'PARTIAL_SELL' ? 'sell' : 'neutral';
  const selected = (value.signals || []).map(item => `${item.group} ${item.name}`).join(' / ');
  const trackLabel = String(value.track || '').replace('_', ' ');
  const base = `${actionLabel} ${Number(value.percentage || 0).toFixed(1)}% · ${trackLabel} · 매도 ${Number(value.sell_percentage || 0).toFixed(1)}% / 매수 ${Number(value.buy_percentage || 0).toFixed(1)}%`;
  return { tone, text: selected ? `${base} · ${selected}` : base };
}

export const __tradeSignalTest = {
  sma,
  ema,
  midpoint,
  crossedAbove,
  crossedBelow,
  percentile,
  linearPredictions,
  dmi,
  obv,
};
