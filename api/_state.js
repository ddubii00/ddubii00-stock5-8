import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const KEY = 'stock5-8:watchlist';
const EMPTY = { mode: 'KRX', items: [] };
const password = () => process.env.STOCK5_PASSWORD || '1222';

export function authorized(req) {
  return String(req.headers['x-stock5-password'] || '') === password();
}

function clean(value) {
  const items = Array.isArray(value?.items) ? value.items.slice(0, 100).map(item => ({
    id: String(item.id || '').slice(0, 100), symbol: String(item.symbol || '').slice(0, 30), name: String(item.name || '').slice(0, 100),
    exchange: String(item.exchange || '').slice(0, 30), type: String(item.type || '').slice(0, 30), group: String(item.group || '3. 롱 관심').slice(0, 30),
    memo: String(item.memo || '').slice(0, 100), memoPosition: { x: Math.max(0, Number(item.memoPosition?.x) || 12), y: Math.max(0, Number(item.memoPosition?.y) || 58) },
    memoSize: { width: Math.min(600, Math.max(120, Number(item.memoSize?.width) || 145)), height: Math.min(400, Math.max(70, Number(item.memoSize?.height) || 78)) },
  })).filter(item => item.id && item.symbol && item.name) : [];
  return { mode: value?.mode === 'KRX2' ? 'KRX2' : 'KRX', items };
}

async function kv(command) {
  const base = process.env.KV_REST_API_URL; const token = process.env.KV_REST_API_TOKEN;
  if (!base || !token) return null;
  const response = await fetch(`${base.replace(/\/$/, '')}/${command}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`공유 저장소 오류 (${response.status})`);
  return response.json();
}

function filePath() { return path.resolve(process.env.STOCK5_DATA_DIR || 'data', 'stock5-8-state.json'); }

export async function loadState() {
  const fromKv = await kv(`get/${encodeURIComponent(KEY)}`);
  if (fromKv) { try { return clean(JSON.parse(fromKv.result || '{}')); } catch { return EMPTY; } }
  const file = filePath(); if (!existsSync(file)) return EMPTY;
  try { return clean(JSON.parse(await readFile(file, 'utf8'))); } catch { return EMPTY; }
}

export async function saveState(value) {
  const state = clean(value); const encoded = encodeURIComponent(JSON.stringify(state));
  if (await kv(`set/${encodeURIComponent(KEY)}/${encoded}`)) return state;
  const file = filePath(); await mkdir(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2), 'utf8'); await rename(temp, file); return state;
}
