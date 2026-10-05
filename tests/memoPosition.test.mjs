import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchoredMemoPosition } from '../src/utils/memoPosition.js';

const size = { width: 145, height: 78 };
const card = { left: 100, top: 20, width: 800 };
const copy = { right: 500, top: 100 };

test('new memo starts to the right of copy at the same row', () => {
  assert.deepEqual(anchoredMemoPosition('copy-right', size, card, copy), { anchor: 'copy-right', x: 405, y: 79 });
});

test('anchored memo stays inside a narrow chart and preserves legacy symbol anchoring', () => {
  assert.equal(anchoredMemoPosition('copy-right', size, { ...card, width: 440 }, copy).x, 287);
  assert.deepEqual(anchoredMemoPosition('symbol-right', size, card, { top: 70 }), { anchor: 'symbol-right', x: 647, y: 49 });
  assert.equal(anchoredMemoPosition(undefined, size, card, copy), null); // Manual coordinates are left alone.
});
