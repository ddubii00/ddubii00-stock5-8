import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { candleTimestamp, cleanTrendLines, logicalAtTime, timeAtLogical } from '../src/utils/trendLines.js';

test('anchors stay on the same trading date as history grows or rolls forward', () => {
  const bars = ['2026-09-28', '2026-09-29', '2026-09-30'].map(time => ({ time }));
  const time = timeAtLogical(bars, 1);
  assert.equal(time, candleTimestamp('2026-09-29'));
  assert.equal(logicalAtTime(bars, time), 1);
  assert.equal(logicalAtTime([{ time: '2026-09-25' }, ...bars], time), 2);
  assert.equal(logicalAtTime(bars.slice(1), time), 0);
  assert.equal(logicalAtTime(bars.slice(2), time), null);
});

test('holiday weeks snap to the actual candle date and preserve intraday seconds', () => {
  const weeks = [{ time: '2026-09-21' }, { time: '2026-09-29' }, { time: '2026-10-05' }];
  assert.equal(timeAtLogical(weeks, 1.4), candleTimestamp('2026-09-29'));
  const minutes = [{ time: 1790730000 }, { time: 1790730060 }];
  assert.equal(timeAtLogical(minutes, 1), 1790730060);
  assert.equal(logicalAtTime(minutes, 1790730060), 1);
});

test('shared state keeps symbol/timeframe drawings separate and strips invalid data', () => {
  const line = { id: 'line1', start: { time: 1790640000, price: 100 }, end: { time: 1790726400, price: 110 }, width: 2, pixels: { x: 20 } };
  const clean = cleanTrendLines({
    '005930.KS:day': [line, { ...line, start: { time: 'bad', price: 2 } }],
    '005930.KS:week': [{ ...line, id: 'week', width: 3 }],
    '005930.KS:1m': [{ ...line, id: 'minute', width: 99 }],
    '000660.KS:day': [],
    invalid: [line],
  });
  assert.equal(clean['005930.KS:day'].length, 1);
  assert.equal(clean['005930.KS:day'][0].pixels, undefined);
  assert.equal(clean['005930.KS:week'][0].width, 3);
  assert.equal(clean['005930.KS:1m'][0].width, 1);
  assert.equal(clean.invalid, undefined);
});

test('server state persists drawings, edits and deletes alongside the memo', async () => {
  const { loadState, saveState } = await import('../api/_state.js');
  const directory = await mkdtemp(path.join(tmpdir(), 'stock5-trend-test-'));
  const old = Object.fromEntries(['STOCK5_DATA_DIR', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'].map(key => [key, process.env[key]]));
  process.env.STOCK5_DATA_DIR = directory;
  process.env.KV_REST_API_URL = '';
  process.env.KV_REST_API_TOKEN = '';
  try {
    const line = { id: 'saved', start: { time: 1790640000, price: 100 }, end: { time: 1790726400, price: 120 }, width: 1 };
    const item = { id: 'test', symbol: '005930.KS', name: '삼성전자', memo: '기존 메모', trendLines: { '005930.KS:day': [line], '005930.KS:week': [] } };
    await saveState({ mode: 'KRX', items: [item] });
    let loaded = await loadState();
    assert.deepEqual(loaded.items[0].trendLines['005930.KS:day'], [line]);
    assert.equal(loaded.items[0].memo, '기존 메모');
    loaded.items[0].trendLines['005930.KS:day'][0].width = 3;
    await saveState(loaded);
    loaded = await loadState();
    assert.equal(loaded.items[0].trendLines['005930.KS:day'][0].width, 3);
    loaded.items[0].trendLines['005930.KS:day'] = [];
    await saveState(loaded);
    assert.deepEqual((await loadState()).items[0].trendLines['005930.KS:day'], []);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
