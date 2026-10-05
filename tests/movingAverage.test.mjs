import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateMA } from '../src/utils/indicators.js';

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
