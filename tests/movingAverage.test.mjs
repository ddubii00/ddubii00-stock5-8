import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateMA } from '../src/utils/indicators.js';
import { candleHistoryLimit, MAX_CANDLE_HISTORY } from '../src/utils/chartHistory.js';

test('every displayed candle has enough 200-period warm-up in every timeframe', () => {
  for (const interval of ['1m', '3m', '5m', '15m', '30m', '60m', 'day', 'week', 'month']) {
    for (const visible of [100, 120, 200, 400, 600, 2000]) {
      const count = candleHistoryLimit(interval, visible);
      assert.ok(count >= visible + 199, `${interval}: ${visible} visible bars need 199 earlier bars`);
      assert.ok(count <= MAX_CANDLE_HISTORY);
      const bars = Array.from({ length: count }, (_, time) => ({ time, close: time + 1 }));
      const displayed = calculateMA(bars, 200).slice(-visible);
      assert.equal(displayed.length, visible);
      assert.ok(displayed.every(bar => Number.isFinite(bar.value)));
    }
  }
  assert.equal(candleHistoryLimit('day', 120), 319);
  assert.equal(candleHistoryLimit('week', 120), 319);
});

test('200-period moving average waits for 200 bars and rolls over the latest closes', () => {
  const bars = Array.from({ length: 220 }, (_, i) => ({ time: i + 1, close: i + 1 }));
  const values = calculateMA(bars, 200);
  assert.equal(values.length, bars.length);
  assert.ok(values.slice(0, 199).every(bar => bar.value === null));
  assert.deepEqual(values[199], { time: 200, value: 100.5 });
  assert.deepEqual(values[200], { time: 201, value: 101.5 });
  assert.deepEqual(values.at(-1), { time: 220, value: 120.5 });
});

test('insufficient history does not fabricate a 200-period moving average', () => {
  const bars = Array.from({ length: 120 }, (_, time) => ({ time, close: 100 }));
  assert.ok(calculateMA(bars, 200).every(bar => bar.value === null));
});
