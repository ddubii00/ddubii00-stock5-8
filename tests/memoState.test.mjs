import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadState, saveState } from '../api/_state.js';

test('new memo right anchor survives shared storage without moving existing memos', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stock5-memo-test-'));
  const keys = ['STOCK5_DATA_DIR', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.STOCK5_DATA_DIR = directory;
  process.env.KV_REST_API_URL = '';
  process.env.KV_REST_API_TOKEN = '';
  try {
    await saveState({ items: [
      { id: 'new', symbol: '005930.KS', name: '삼성전자', memo: '새 메모', memoPosition: { anchor: 'symbol-right', x: 695, y: 40 } },
      { id: 'existing', symbol: '000660.KS', name: 'SK하이닉스', memo: '기존 메모', memoPosition: { x: 150, y: 80 } },
    ] });
    const loaded = await loadState();
    assert.deepEqual(loaded.items[0].memoPosition, { anchor: 'symbol-right', x: 695, y: 40 });
    assert.deepEqual(loaded.items[1].memoPosition, { x: 150, y: 80 });
    loaded.items[0].memoPosition = { x: 320, y: 100 };
    await saveState(loaded);
    const moved = (await loadState()).items[0];
    assert.deepEqual(moved.memoPosition, { x: 320, y: 100 });
    assert.equal(moved.memo, '새 메모');
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
