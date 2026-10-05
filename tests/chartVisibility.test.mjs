import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyGlobalVisibility, toggleChartVisibility } from '../src/utils/chartVisibility.js';

test('a chart can hide bands while global BB remains on', () => {
  const first = toggleChartVisibility({ globalVisible: true, visible: true });
  const second = { globalVisible: true, visible: true };
  assert.equal(first.visible, false);
  assert.equal(applyGlobalVisibility(first, true), first); // Polling/rendering must not reset the override.
  assert.equal(second.visible, true);
  assert.equal(toggleChartVisibility(first).visible, true);
});

test('a chart can show bands while global BB remains off', () => {
  const first = toggleChartVisibility({ globalVisible: false, visible: false });
  assert.equal(first.visible, true);
  assert.equal(applyGlobalVisibility(first, false), first);
  assert.equal(toggleChartVisibility(first).visible, false);
});

test('clicking global BB again applies its new value to every chart', () => {
  assert.deepEqual(applyGlobalVisibility({ globalVisible: true, visible: true }, false), { globalVisible: false, visible: false });
  assert.deepEqual(applyGlobalVisibility({ globalVisible: false, visible: true }, true), { globalVisible: true, visible: true });
  assert.deepEqual(applyGlobalVisibility({ globalVisible: false, visible: false }, true), { globalVisible: true, visible: true });
});
