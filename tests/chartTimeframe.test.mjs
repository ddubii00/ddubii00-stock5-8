import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyGlobalWeekly, selectTimeframe } from '../src/utils/chartTimeframe.js';

const day = { interval: 'day', label: '일' };
const week = { interval: 'week', label: '주' };
const minute = { interval: '5m', label: '5분' };
const initial = tf => ({ globalWeekly: false, tf, restoreTf: day });

test('global weekly enables both independent chart timeframes and restores their previous selection', () => {
  const main = applyGlobalWeekly(initial(minute), true, week);
  const ichi = applyGlobalWeekly(initial(day), true, week);
  assert.equal(main.tf, week);
  assert.equal(ichi.tf, week);
  assert.equal(applyGlobalWeekly(main, false, week).tf, minute);
  assert.equal(applyGlobalWeekly(ichi, false, week).tf, day);
});

test('local day override stays selected during polling and when global weekly is disabled', () => {
  const enabled = applyGlobalWeekly(initial(minute), true, week);
  const overridden = selectTimeframe(enabled, day);
  assert.equal(applyGlobalWeekly(overridden, true, week), overridden);
  assert.equal(applyGlobalWeekly(overridden, false, week).tf, day);
  assert.equal(enabled.tf, week); // Other chart selection is untouched.
});

test('turning weekly back on reapplies week after a local override', () => {
  const overridden = selectTimeframe(applyGlobalWeekly(initial(day), true, week), minute);
  const disabled = applyGlobalWeekly(overridden, false, week);
  assert.equal(disabled.tf, minute);
  assert.equal(applyGlobalWeekly(disabled, true, week).tf, week);
});
