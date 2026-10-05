import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadState, saveState } from '../api/_state.js';

test('memo anchors and attention flags survive shared storage without moving existing memos', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stock5-memo-test-'));
  const keys = ['STOCK5_DATA_DIR', 'STOCK5_DB_ROOT', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.STOCK5_DATA_DIR = directory;
  process.env.STOCK5_DB_ROOT = '';
  process.env.KV_REST_API_URL = '';
  process.env.KV_REST_API_TOKEN = '';
  try {
    await saveState({ items: [
      { id: 'new', symbol: '005930.KS', name: '삼성전자', memo: '새 메모', memoPosition: { anchor: 'copy-right', x: 695, y: 40 }, attention: true },
      { id: 'existing', symbol: '000660.KS', name: 'SK하이닉스', memo: '기존 메모', memoPosition: { x: 150, y: 80 } },
      { id: 'old-anchor', symbol: 'AAPL', name: '애플', memoPosition: { anchor: 'symbol-right', x: 200, y: 40 }, attention: 'false' },
    ] });
    const loaded = await loadState();
    assert.deepEqual(loaded.items[0].memoPosition, { anchor: 'copy-right', x: 695, y: 40 });
    assert.deepEqual(loaded.items[1].memoPosition, { x: 150, y: 80 });
    assert.deepEqual(loaded.items[2].memoPosition, { anchor: 'symbol-right', x: 200, y: 40 });
    assert.equal(loaded.items[0].attention, true);
    assert.equal(loaded.items[1].attention, false); // Missing flag defaults to OFF.
    assert.equal(loaded.items[2].attention, false); // Never treat the string "false" as ON.
    loaded.items[0].memoPosition = { x: 320, y: 100 };
    loaded.items[0].attention = false;
    await saveState(loaded);
    const moved = (await loadState()).items[0];
    assert.deepEqual(moved.memoPosition, { x: 320, y: 100 });
    assert.equal(moved.memo, '새 메모');
    assert.equal(moved.attention, false);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
