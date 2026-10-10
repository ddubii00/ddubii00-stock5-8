import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateThreeLineBreak } from '../src/utils/threeLineBreak.js';
import { cleanTrendLines } from '../src/utils/trendLines.js';

const bars = (closes) => closes.map((close, i) => ({ time: 1000 + i * 60, open: close - 1, high: close + 20, low: close - 20, close, volume: 10 }));

test('upward continuation and strict three-line downward reversal use only closing prices', () => {
  const result = calculateThreeLineBreak(bars([100, 110, 120, 130, 129, 101, 100, 99, 98]));
  assert.deepEqual(result.map(line => [line.open, line.close]), [[100, 110], [110, 120], [120, 130], [120, 99], [99, 98]]);
  assert.equal(result[3].time, 1000 + 7 * 60);
  assert.equal(result[3].volume, 40);
  assert.equal(result[3].sourceCount, 4);
  assert.equal(result[3].startTime, 1000 + 4 * 60);
  assert.ok(result.every(line => line.high === Math.max(line.open, line.close) && line.low === Math.min(line.open, line.close)));
});

test('downward trend reverses upward only beyond the prior three-line high', () => {
  const result = calculateThreeLineBreak(bars([100, 90, 80, 70, 71, 100, 101]));
  assert.deepEqual(result.map(line => [line.open, line.close]), [[100, 90], [90, 80], [80, 70], [80, 101]]);
});

test('the reversal window rolls over the last three lines', () => {
  const result = calculateThreeLineBreak(bars([100, 110, 120, 130, 140, 111, 110, 109]));
  assert.deepEqual(result.at(-1).open, 130);
  assert.deepEqual(result.at(-1).close, 109);
  assert.equal(result.at(-1).sourceCount, 3);
});

test('flat prices and an empty source do not create fabricated lines', () => {
  assert.deepEqual(calculateThreeLineBreak([]), []);
  assert.deepEqual(calculateThreeLineBreak(bars([100, 100, 100])), []);
  assert.deepEqual(calculateThreeLineBreak(bars([100])), []);
});

test('volumes cover each source bar once, and pending volume waits for a new line', () => {
  const source = bars([100, 100, 110, 109, 111, 110]);
  const original = structuredClone(source);
  const result = calculateThreeLineBreak(source);
  assert.deepEqual(result.map(line => line.volume), [30, 20]);
  assert.deepEqual(source, original); // Cached candles must be restored unchanged.
  source[1].volume = null;
  assert.equal(calculateThreeLineBreak(source)[0].volume, null);
});

test('dates, weekly dates and intraday seconds remain original breakout anchors', () => {
  for (const times of [['2026-09-01', '2026-09-08', '2026-09-15'], [123, 456, 789]]) {
    const source = bars([100, 110, 120]).map((bar, i) => ({ ...bar, time: times[i] }));
    assert.deepEqual(calculateThreeLineBreak(source).map(line => line.time), times.slice(1));
  }
});

test('line-break drawings persist separately from original timeframe drawings', () => {
  const line = { id: 'example', start: { time: 1790640000, price: 100 }, end: { time: 1790726400, price: 110 }, width: 1 };
  const saved = cleanTrendLines({ 'TEST:day': [line], 'TEST:day:line-break': [line] });
  assert.equal(saved['TEST:day'].length, 1);
  assert.equal(saved['TEST:day:line-break'].length, 1);
});
