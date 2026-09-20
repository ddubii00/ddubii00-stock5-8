import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeTradeSignal,
  finalizeTradeSignalPercentages,
  __tradeSignalTest,
} from '../src/utils/tradeSignal.js';

function makeHistory(lastClose = null, lastOpen = null, lastVolume = null) {
  const history = [];
  for (let index = 0; index < 180; index += 1) {
    const price = 100 + (index * 0.05);
    history.push({
      date: `2026${String(Math.floor(index / 28) % 12 + 1).padStart(2, '0')}${String(index % 28 + 1).padStart(2, '0')}`,
      open: price - 0.2,
      high: price + 1,
      low: price - 1,
      close: price,
      volume: 1000,
    });
  }
  if (lastClose !== null) {
    history.at(-1).open = lastOpen;
    history.at(-1).high = Math.max(lastOpen, lastClose) + 1;
    history.at(-1).low = Math.min(lastOpen, lastClose) - 1;
    history.at(-1).close = lastClose;
    history.at(-1).volume = lastVolume;
  }
  return history;
}

test('stock1 bearish fixture produces a partial sell quantity', () => {
  const result = analyzeTradeSignal(makeHistory(80, 108, 3000), 100);
  assert.equal(result.action, 'PARTIAL_SELL');
  assert.ok(result.percentage > 0);
  assert.equal(result.recommended_quantity, Math.ceil(result.percentage));
  assert.ok(result.recommended_quantity <= 100);
});

test('stock1 bullish fixture produces a partial buy quantity', () => {
  const history = makeHistory();
  for (let index = 120; index < 179; index += 1) {
    const price = 115 - ((index - 120) * 0.25);
    history[index] = { ...history[index], open: price + 0.1, high: price + 1, low: price - 1, close: price };
  }
  history[history.length - 1] = { ...history.at(-1), open: 99, high: 122, low: 98, close: 121, volume: 4000 };
  const result = analyzeTradeSignal(history, 80);
  assert.equal(result.action, 'PARTIAL_BUY');
  assert.ok(result.recommended_quantity > 0);
});

test('at least 120 completed daily bars are required', () => {
  assert.throws(() => analyzeTradeSignal(makeHistory().slice(0, 119), 10), /120거래일/);
});

test('crossover means a new crossing, not merely being above', () => {
  const { crossedAbove } = __tradeSignalTest;
  assert.equal(crossedAbove([1, 2, 3], [2, 2, 2]), true);
  assert.equal(crossedAbove([3, 4, 5], [2, 2, 2]), false);
});

test('TRACK_2 halves raw buy percentage', () => {
  const result = finalizeTradeSignalPercentages(0, 15, 'TRACK_2');
  assert.equal(result.action, 'PARTIAL_BUY');
  assert.equal(result.percentage, 7.5);
  assert.equal(result.buyPercentage, 7.5);
});

test('higher side wins and an exact tie becomes HOLD', () => {
  assert.equal(finalizeTradeSignalPercentages(5, 15, 'TRACK_1').action, 'PARTIAL_BUY');
  assert.equal(finalizeTradeSignalPercentages(15, 15, 'TRACK_1').action, 'HOLD');
});
