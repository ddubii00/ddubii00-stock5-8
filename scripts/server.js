import process from 'node:process';
import { existsSync } from 'node:fs';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import WebSocket from 'ws';
import YahooFinance from 'yahoo-finance2';
import { analyzeCharts } from '../api/_analyze.js';
import { authorized, loadState, saveState } from '../api/_state.js';

dotenv.config({ path: '.env.local', quiet: true });
dotenv.config({ quiet: true });

const yahooFinance = new YahooFinance();
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '25mb' }));

app.all('/api/state', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'invalid password' });
  try {
    if (req.method === 'GET') return res.json(await loadState());
    if (req.method === 'PUT') return res.json(await saveState(req.body));
    return res.status(405).json({ error: 'method not allowed' });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

let krxCache = { loadedAt: 0, items: [] };
const ohlcvCache = new Map();
// Chart and Ichimoku request different lengths of weekly history. Keep one
// canonical source response so switching/overlaying them does not refetch it.
const weeklyOhlcvCache = new Map();
const weeklyOhlcvInFlight = new Map();
const WEEKLY_OHLCV_CACHE_TTL_MS = 30 * 60 * 1000;
const WEEKLY_OHLCV_SOURCE_BARS = 300;
const koreanDailyHistoryCache = new Map();
const koreanDailyHistoryInFlight = new Map();
const koreanOhlcvLogAt = new Map();
const KIS_HISTORY_PAGE_DAYS = 180;
const KIS_HISTORY_MAX_PAGES = 32;
const quoteCache = new Map();
let kisTokenCache = { token: '', expiresAt: 0 };
let kisApprovalCache = { key: '', expiresAt: 0 };
const REALTIME_QUOTE_TTL_MS = 250;
const KRX_MINUTE_TTL_MS = 300;
const KIS_TR = {
  DOMESTIC_STOCK: 'H0STCNT0',
  DOMESTIC_INDEX: 'H0UPCNT0',
  OVERSEAS_STOCK: 'HDFSCNT0',
};
const KIS_REALTIME_COLUMNS = {
  [KIS_TR.DOMESTIC_STOCK]: 46,
  [KIS_TR.DOMESTIC_INDEX]: 30,
  [KIS_TR.OVERSEAS_STOCK]: 26,
};
const KIS_INDEX_SYMBOLS = {
  '0001': { key: '0001', symbol: '^KS11' },
  '^KS11': { key: '0001', symbol: '^KS11' },
  KOSPI: { key: '0001', symbol: '^KS11' },
  '1001': { key: '1001', symbol: '^KQ11' },
  '^KQ11': { key: '1001', symbol: '^KQ11' },
  KOSDAQ: { key: '1001', symbol: '^KQ11' },
  '2001': { key: '2001', symbol: '^KS200' },
  '^KS200': { key: '2001', symbol: '^KS200' },
  KOSPI200: { key: '2001', symbol: '^KS200' },
};
const KIS_US_WS_EXCHANGE = {
  NAS: 'DNAS',
  NASD: 'DNAS',
  NASDAQ: 'DNAS',
  NYS: 'DNYS',
  NYSE: 'DNYS',
  AMS: 'DAMS',
  AMEX: 'DAMS',
  ASE: 'DAMS',
  BAQ: 'RBAQ',
  BAY: 'RBAY',
  BAA: 'RBAA',
};
const realtimeClients = new Map();
const realtimeSymbols = new Map();
const realtimeQuotes = new Map();
let kisRealtimeSocket = null;
let kisRealtimeConnecting = null;
let kisReconnectTimer = null;
let kisRealtimeBlockedUntil = 0;
let kisReconnectAttempts = 0;
let kisAlreadyInUseLoggedAt = 0;
const KIS_RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000];

const KRX_FALLBACK_ITEMS = [
  { name: 'SK하이닉스', code: '000660', marketType: '유가증권' },
  { name: '삼성전자', code: '005930', marketType: '유가증권' },
  { name: '한미반도체', code: '042700', marketType: '유가증권' },
  { name: '현대차', code: '005380', marketType: '유가증권' },
  { name: '기아', code: '000270', marketType: '유가증권' },
  { name: 'NAVER', code: '035420', marketType: '유가증권' },
  { name: '카카오', code: '035720', marketType: '유가증권' },
  { name: '셀트리온', code: '068270', marketType: '유가증권' },
  { name: '삼성바이오로직스', code: '207940', marketType: '유가증권' },
  { name: 'LG에너지솔루션', code: '373220', marketType: '유가증권' },
];
const KRX_SEARCH_ALIASES = {
  '000660': ['하이', '하이닉스', 'sk하이', 'sk하이닉스', '에스케이하이닉스', 'hynix'],
  '005930': ['삼전', '삼성', '삼성전자', 'samsung'],
};

function decodeEucKr(buffer) {
  try { return new TextDecoder('euc-kr').decode(buffer); }
  catch { return new TextDecoder('utf-8').decode(buffer); }
}

async function loadKrxList() {
  const now = Date.now();
  if (now - krxCache.loadedAt < 1000 * 60 * 60 * 6 && krxCache.items.length) return krxCache.items;
  try {
    const res = await fetch('https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR,ko;q=0.9' },
    });
    if (!res.ok) throw new Error(`KRX responded ${res.status}`);
    const html = decodeEucKr(new Uint8Array(await res.arrayBuffer()));
    const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)];
    const items = [];
    for (const row of rows) {
      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m =>
        m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
      );
      if (cells.length < 3) continue;
      const name = cells[0];
      const marketType = String(cells[1] || '').trim();
      const rawCode = String(cells[2] || '').trim();
      const digits = rawCode.replace(/\D/g, '');
      if (!name || digits.length !== 6) continue;
      items.push({ name, code: digits, marketType });
    }
    const merged = mergeKrxItems(items);
    krxCache = { loadedAt: now, items: merged };
    return merged;
  } catch (e) {
    console.error('KRX load failed:', e.message);
    return krxCache.items.length ? krxCache.items : KRX_FALLBACK_ITEMS;
  }
}

function mergeKrxItems(items) {
  const byCode = new Map();
  [...KRX_FALLBACK_ITEMS, ...(items || [])].forEach((item) => {
    if (item?.code) byCode.set(item.code, item);
  });
  return [...byCode.values()];
}

function normalizeSearchText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '');
}

function krxSearchScore(item, query) {
  const q = normalizeSearchText(query);
  const name = normalizeSearchText(item.name);
  const code = String(item.code || '');
  const aliases = (KRX_SEARCH_ALIASES[code] || []).map(normalizeSearchText);
  if (!q) return 0;
  if (code === q) return 100;
  if (name === q) return 95;
  if (aliases.includes(q)) return 90;
  if (name.startsWith(q)) return 80;
  if (aliases.some(alias => alias.startsWith(q))) return 75;
  if (name.includes(q)) return 60;
  if (aliases.some(alias => alias.includes(q) || q.includes(alias))) return 55;
  if (code.includes(q)) return 50;
  return 0;
}

const INDEX_MAP = {
  KOSPI: { symbol: '^KS11', name: 'KOSPI 종합', exchange: 'KRX' },
  KOSDAQ: { symbol: '^KQ11', name: 'KOSDAQ 종합', exchange: 'KRX' },
  'S&P500': { symbol: '^GSPC', name: 'S&P 500', exchange: 'NYSE' },
  SP500: { symbol: '^GSPC', name: 'S&P 500', exchange: 'NYSE' },
  NASDAQ: { symbol: '^IXIC', name: 'NASDAQ 종합', exchange: 'NASDAQ' },
  DOW: { symbol: '^DJI', name: 'Dow Jones', exchange: 'NYSE' },
  DOWJONES: { symbol: '^DJI', name: 'Dow Jones', exchange: 'NYSE' },
  VIX: { symbol: '^VIX', name: 'VIX 공포지수', exchange: 'CBOE' },
  NIKKEI: { symbol: '^N225', name: 'Nikkei 225', exchange: 'JPX' },
  HANGSENG: { symbol: '^HSI', name: 'Hang Seng', exchange: 'HKEX' },
};

function parseNumeric(text) {
  const s = String(text || '').replace(/,/g, '').trim();
  if (!s || /^N\/?[AD]$/i.test(s) || /^null$/i.test(s)) return null;
  const v = Number(s.replace(/[^\d.+-]/g, ''));
  return Number.isFinite(v) ? v : null;
}

function quoteFromValues(price, change, changePct) {
  const p = Number(price);
  let c = Number(change);
  let pct = Number(changePct);
  if (!Number.isFinite(p)) return null;

  if (
    Number.isFinite(c) &&
    Number.isFinite(pct) &&
    c !== 0 &&
    pct !== 0 &&
    Math.sign(c) !== Math.sign(pct)
  ) {
    c = Math.sign(pct) * Math.abs(c);
  }

  return {
    price: p,
    change: Number.isFinite(c) ? c : null,
    changePct: Number.isFinite(pct) ? pct : null,
  };
}

function isKoreanStockSymbol(symbol) {
  return /^\d{6}(\.(KS|KQ))?$/.test(symbol || '') || /\.(KS|KQ)$/.test(symbol || '');
}

function cleanKoreanCode(symbol) {
  return String(symbol || '').replace(/\.(KS|KQ)$/, '');
}

function quoteFromCandles(candles) {
  const valid = (candles || []).filter(candle => Number.isFinite(candle?.close));
  if (!valid.length) return null;
  const latest = valid[valid.length - 1];
  const previous = valid.slice(0, -1).reverse().find(candle => Number.isFinite(candle.close));
  const price = Number(latest.close);
  const previousClose = previous ? Number(previous.close) : null;
  const change = Number.isFinite(previousClose) ? price - previousClose : null;
  const changePct = Number.isFinite(previousClose) && previousClose !== 0 ? (change / previousClose) * 100 : null;
  return quoteFromValues(price, change, changePct);
}

function kstDateKeyFromSeconds(time) {
  if (typeof time !== 'number') return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(time * 1000)).replaceAll('-', '');
}

function quoteFromPriceAndPreviousClose(price, previousClose) {
  const p = Number(price);
  const prev = Number(previousClose);
  if (!Number.isFinite(p)) return null;
  const change = Number.isFinite(prev) ? p - prev : null;
  const changePct = Number.isFinite(prev) && prev !== 0 ? (change / prev) * 100 : null;
  return quoteFromValues(p, change, changePct);
}

function kisBaseUrl() {
  return process.env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';
}

function kisWsUrl() {
  const base = process.env.KIS_WS_URL || 'ws://ops.koreainvestment.com:21000';
  return base.endsWith('/tryitout') ? base : `${base.replace(/\/$/, '')}/tryitout`;
}

function hasKisConfig() {
  // Oracle can keep a persistent KIS REST/WebSocket session; Vercel must use public fallback sources.
  if (process.env.VERCEL === '1') return false;
  const provider = String(process.env.MARKET_DATA_PROVIDER || 'auto').trim().toLowerCase();
  if (provider === 'naver' || provider === 'fallback') return false;
  return Boolean(process.env.KIS_APP_KEY && process.env.KIS_APP_SECRET);
}

async function fetchKisAccessToken() {
  if (!hasKisConfig()) return '';
  const now = Date.now();
  if (kisTokenCache.token && kisTokenCache.expiresAt - now > 60_000) return kisTokenCache.token;

  const res = await fetch(`${kisBaseUrl()}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`KIS token responded ${res.status}`);
  const json = await res.json();
  const token = json.access_token || '';
  const expiresIn = Number(json.expires_in) || 3600;
  kisTokenCache = { token, expiresAt: now + expiresIn * 1000 };
  return token;
}

async function fetchKisApprovalKey() {
  if (!hasKisConfig()) return '';
  const now = Date.now();
  if (kisApprovalCache.key && kisApprovalCache.expiresAt - now > 60_000) return kisApprovalCache.key;

  const res = await fetch(`${kisBaseUrl()}/oauth2/Approval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: process.env.KIS_APP_KEY,
      secretkey: process.env.KIS_APP_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`KIS approval key responded ${res.status}`);
  const json = await res.json();
  const key = json.approval_key || '';
  if (!key) throw new Error('KIS approval key missing');
  kisApprovalCache = { key, expiresAt: now + 23 * 60 * 60 * 1000 };
  return key;
}

function kisHeaders(token, trId) {
  return {
    Authorization: `Bearer ${token}`,
    appkey: process.env.KIS_APP_KEY,
    appsecret: process.env.KIS_APP_SECRET,
    tr_id: trId,
    custtype: 'P',
  };
}

async function fetchKisDomesticStockQuote(symbol, market = 'regular') {
  const token = await fetchKisAccessToken();
  if (!token) return null;
  const params = new URLSearchParams({
    // UN is the KIS integrated market: it includes NXT and KRX's 16:00~20:00
    // after-market execution. J remains the regular KRX view.
    FID_COND_MRKT_DIV_CODE: market === 'after' ? 'UN' : 'J',
    FID_INPUT_ISCD: cleanKoreanCode(symbol),
  });
  const res = await fetch(`${kisBaseUrl()}/uapi/domestic-stock/v1/quotations/inquire-price?${params}`, {
    headers: kisHeaders(token, 'FHKST01010100'),
  });
  if (!res.ok) throw new Error(`KIS domestic quote responded ${res.status}`);
  const json = await res.json();
  const out = json.output || {};
  return quoteFromValues(
    parseNumeric(out.stck_prpr),
    parseNumeric(out.prdy_vrss),
    parseNumeric(out.prdy_ctrt)
  );
}

async function fetchKoreanStockQuote(symbol) {
  const code = cleanKoreanCode(symbol);
  const [intraday, daily] = await Promise.all([
    fetchKoreanOhlcv(code, '1m', 10).catch(() => []),
    fetchKoreanOhlcv(code, 'day', 3).catch(() => []),
  ]);
  const minuteCandles = filterKrxRegularMinutes(intraday || []);
  const latestSource = minuteCandles.length ? minuteCandles : (intraday || []);
  const latest = latestSource[latestSource.length - 1] || daily[daily.length - 1];
  const latestDate = latest?.date || kstDateKeyFromSeconds(latest?.time);
  const dailyRows = (daily || []).filter(row => Number.isFinite(row?.close));
  const previousDaily = [...dailyRows].reverse().find(row => row.date !== latestDate);
  const previousClose = previousDaily?.close ?? dailyRows[dailyRows.length - 2]?.close;
  return quoteFromPriceAndPreviousClose(latest?.close, previousClose) || quoteFromCandles(dailyRows);
}

function kisExchangeForUsSymbol(symbol) {
  const overrides = (() => {
    try { return JSON.parse(process.env.KIS_US_EXCHANGE_OVERRIDES || '{}'); }
    catch { return {}; }
  })();
  const upper = String(symbol || '').toUpperCase();
  return overrides[upper] || process.env.KIS_DEFAULT_US_EXCHANGE || 'NAS';
}

function realtimeKeyForSymbol(symbol) {
  return String(symbol || '').toUpperCase().replace(/\.(KS|KQ)$/, '');
}

function kisRealtimeTopic(symbol) {
  const raw = String(symbol || '').trim();
  const upper = raw.toUpperCase();
  const index = KIS_INDEX_SYMBOLS[upper];
  if (index) {
    return {
      kind: 'domestic-index',
      trId: KIS_TR.DOMESTIC_INDEX,
      trKey: index.key,
      appSymbol: index.symbol,
      cacheKey: realtimeKeyForSymbol(index.symbol),
    };
  }

  if (isKoreanStockSymbol(raw)) {
    const code = cleanKoreanCode(raw);
    return {
      kind: 'domestic-stock',
      trId: KIS_TR.DOMESTIC_STOCK,
      trKey: code,
      appSymbol: code,
      cacheKey: code,
    };
  }

  if (!upper.startsWith('^') && !upper.includes('=')) {
    const exchange = kisExchangeForUsSymbol(upper);
    const prefix = KIS_US_WS_EXCHANGE[String(exchange || '').toUpperCase()] || 'DNAS';
    return {
      kind: 'overseas-stock',
      trId: KIS_TR.OVERSEAS_STOCK,
      trKey: `${prefix}${upper}`,
      appSymbol: upper,
      cacheKey: upper,
    };
  }

  return null;
}

async function fetchKisOverseasStockQuote(symbol) {
  if (String(symbol || '').startsWith('^') || String(symbol || '').includes('=')) return null;
  const token = await fetchKisAccessToken();
  if (!token) return null;
  const params = new URLSearchParams({
    AUTH: '',
    EXCD: kisExchangeForUsSymbol(symbol),
    SYMB: String(symbol || '').toUpperCase(),
  });
  const res = await fetch(`${kisBaseUrl()}/uapi/overseas-price/v1/quotations/price?${params}`, {
    headers: kisHeaders(token, 'HHDFS00000300'),
  });
  if (!res.ok) throw new Error(`KIS overseas quote responded ${res.status}`);
  const json = await res.json();
  const out = json.output || {};
  const price = parseNumeric(out.last);
  const change = parseNumeric(out.diff);
  const changePct = parseNumeric(out.rate);
  return quoteFromValues(price, change, changePct);
}

async function fetchNaverIndexQuotes() {
  const cacheKey = 'naver-index-quotes';
  const now = Date.now();
  const cached = quoteCache.get(cacheKey);
  if (cached && now - cached.ts < 800) return cached.data;

  const res = await fetch('https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI,KOSDAQ', {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR,ko;q=0.9', Referer: 'https://finance.naver.com/' },
  });
  if (!res.ok) throw new Error(`Naver index quote responded ${res.status}`);
  const json = await res.json();
  const data = new Map((json.datas || []).map(item => [
    item.itemCode,
    quoteFromValues(
      parseNumeric(item.closePrice),
      parseNumeric(item.compareToPreviousClosePrice),
      parseNumeric(item.fluctuationsRatio)
    ),
  ]));
  quoteCache.set(cacheKey, { ts: now, data });
  return data;
}

async function fetchRealtimeQuote(symbol, market = 'regular') {
  const key = String(symbol || '').toUpperCase();
  const realtime = realtimeQuotes.get(realtimeKeyForSymbol(key));
  const regularKoreanAfterClose = market === 'regular' && isKoreanStockSymbol(symbol) && !isKrxRegularQuoteWindow();
  // After 15:30 KRX mode must show the official regular-session close, never
  // an after-market WebSocket tick cached under the same symbol.
  if (!regularKoreanAfterClose && market !== 'after' && realtime && Date.now() - realtime.receivedAt < 10_000) return realtime.quote;

  const kisQuoteKey = `kis-quote:${symbol}:${market}`;
  const now = Date.now();
  const kisCached = quoteCache.get(kisQuoteKey);
  if (kisCached && now - kisCached.ts < REALTIME_QUOTE_TTL_MS) return kisCached.data;

  if (hasKisConfig() && !regularKoreanAfterClose) {
    try {
      const kisQuote = isKoreanStockSymbol(symbol)
        ? await fetchKisDomesticStockQuote(symbol, market)
        : await fetchKisOverseasStockQuote(symbol);
      if (kisQuote) {
        quoteCache.set(kisQuoteKey, { ts: now, data: kisQuote });
        return kisQuote;
      }
    } catch (e) {
      console.warn(`KIS quote fallback [${symbol}]:`, e.message);
    }
  }

  if (isKoreanStockSymbol(symbol)) {
    const cacheKey = `krx-quote:${symbol}:${market}`;
    const cached = quoteCache.get(cacheKey);
    if (cached && now - cached.ts < REALTIME_QUOTE_TTL_MS) return cached.data;
    const krxQuote = await fetchKoreanStockQuote(symbol);
    if (krxQuote) {
      quoteCache.set(cacheKey, { ts: now, data: krxQuote });
      return krxQuote;
    }
  }

  if (key === '^KS11' || key === 'KOSPI') {
    return (await fetchNaverIndexQuotes()).get('KOSPI') || null;
  }
  if (key === '^KQ11' || key === 'KOSDAQ') {
    return (await fetchNaverIndexQuotes()).get('KOSDAQ') || null;
  }

  const cacheKey = `quote:${symbol}`;
  const cached = quoteCache.get(cacheKey);
  if (cached && now - cached.ts < 3000) return cached.data;

  const q = await yahooFinance.quote(symbol);
  const price = q.regularMarketPrice ?? q.postMarketPrice ?? q.preMarketPrice;
  const previousClose = q.regularMarketPreviousClose;
  const change = q.regularMarketChange ?? (Number.isFinite(price) && Number.isFinite(previousClose) ? price - previousClose : null);
  const changePct = q.regularMarketChangePercent ?? (Number.isFinite(change) && Number.isFinite(previousClose) && previousClose !== 0 ? (change / previousClose) * 100 : null);
  const data = quoteFromValues(price, change, changePct);
  quoteCache.set(cacheKey, { ts: now, data });
  return data;
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastRealtimeQuote(symbol, quote) {
  const code = realtimeKeyForSymbol(symbol);
  const payload = { symbol: code, quote, receivedAt: Date.now() };
  realtimeQuotes.set(code, payload);

  for (const [id, client] of realtimeClients) {
    if (client.symbol !== code) continue;
    try {
      sendSse(client.res, 'quote', payload);
    } catch {
      realtimeClients.delete(id);
    }
  }
}

function signedKisValue(signCode, value) {
  const n = parseNumeric(value);
  if (!Number.isFinite(n)) return null;
  const code = String(signCode || '').trim();
  if (code === '4' || code === '5') return -Math.abs(n);
  if (code === '1' || code === '2') return Math.abs(n);
  return n;
}

function kisSubscribeMessage(approvalKey, topic, trType = '1') {
  return JSON.stringify({
    header: {
      approval_key: approvalKey,
      custtype: 'P',
      tr_type: trType,
      'content-type': 'utf-8',
    },
    body: {
      input: {
        tr_id: topic.trId,
        tr_key: topic.trKey,
      },
    },
  });
}

function subscribeKisSymbol(cacheKey) {
  const topic = realtimeSymbols.get(cacheKey);
  if (!topic || !kisRealtimeSocket || kisRealtimeSocket.readyState !== WebSocket.OPEN) return;
  fetchKisApprovalKey()
    .then(approvalKey => kisRealtimeSocket?.send(kisSubscribeMessage(approvalKey, topic, '1')))
    .catch(e => console.warn(`KIS realtime subscribe skipped [${cacheKey}]:`, e.message));
}

function unsubscribeKisSymbol(cacheKey) {
  const topic = realtimeSymbols.get(cacheKey);
  if (!topic) return;
  realtimeSymbols.delete(cacheKey);
  if (!kisRealtimeSocket || kisRealtimeSocket.readyState !== WebSocket.OPEN) return;
  fetchKisApprovalKey()
    .then(approvalKey => kisRealtimeSocket?.send(kisSubscribeMessage(approvalKey, topic, '2')))
    .catch(e => console.warn(`KIS realtime unsubscribe skipped [${cacheKey}]:`, e.message));
}

function hasRealtimeClientForSymbol(cacheKey) {
  for (const client of realtimeClients.values()) {
    if (client.symbol === cacheKey) return true;
  }
  return false;
}

function isKrxRegularQuoteWindow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const weekday = parts.find(part => part.type === 'weekday')?.value;
  const hour = Number(parts.find(part => part.type === 'hour')?.value);
  const minute = Number(parts.find(part => part.type === 'minute')?.value);
  const currentMinute = hour * 60 + minute;
  return weekday !== 'Sat' && weekday !== 'Sun' && currentMinute >= 9 * 60 && currentMinute <= 15 * 60 + 33;
}

function blockKisRealtime(socket) {
  kisRealtimeBlockedUntil = Date.now() + 5 * 60 * 1000;
  kisReconnectAttempts = 0;
  if (Date.now() - kisAlreadyInUseLoggedAt > 60_000) {
    console.warn('KIS realtime blocked for 5 minutes: ALREADY IN USE appkey');
    kisAlreadyInUseLoggedAt = Date.now();
  }
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
}

function scheduleKisReconnect() {
  if (kisReconnectTimer || !realtimeSymbols.size) return;
  const now = Date.now();
  const blockedDelay = kisRealtimeBlockedUntil - now;
  const delay = blockedDelay > 0
    ? blockedDelay
    : KIS_RECONNECT_DELAYS_MS[Math.min(kisReconnectAttempts++, KIS_RECONNECT_DELAYS_MS.length - 1)];
  kisReconnectTimer = setTimeout(() => {
    kisReconnectTimer = null;
    if (!realtimeSymbols.size) return;
    connectKisRealtime().catch(e => {
      if (Date.now() >= kisRealtimeBlockedUntil) console.warn('KIS realtime reconnect failed:', e.message);
      scheduleKisReconnect();
    });
  }, delay);
}

function parseKisDomesticStockRow(row) {
  const price = parseNumeric(row[2]);
  if (!Number.isFinite(price)) return null;
  const sign = row[3];
  return {
    symbol: row[0],
    quote: {
      price,
      change: signedKisValue(sign, row[4]),
      changePct: signedKisValue(sign, row[5]),
      open: parseNumeric(row[7]),
      high: parseNumeric(row[8]),
      low: parseNumeric(row[9]),
      ask: parseNumeric(row[10]),
      bid: parseNumeric(row[11]),
      tradeVolume: parseNumeric(row[12]),
      volume: parseNumeric(row[13]),
      tradeTime: row[1],
      tradeDate: row[33],
      source: 'kis-ws',
    },
  };
}

function parseKisDomesticIndexRow(row) {
  const index = KIS_INDEX_SYMBOLS[row[0]];
  const price = parseNumeric(row[2]);
  if (!index || !Number.isFinite(price)) return null;
  const sign = row[3];
  return {
    symbol: index.symbol,
    quote: {
      price,
      change: signedKisValue(sign, row[4]),
      changePct: signedKisValue(sign, row[9]),
      open: parseNumeric(row[10]),
      high: parseNumeric(row[11]),
      low: parseNumeric(row[12]),
      tradeVolume: parseNumeric(row[7]),
      volume: parseNumeric(row[5]),
      tradeTime: row[1],
      source: 'kis-ws-index',
    },
  };
}

function parseKisOverseasStockRow(row) {
  const topic = [...realtimeSymbols.values()].find(item => item.trId === KIS_TR.OVERSEAS_STOCK && item.trKey === row[0]);
  const price = parseNumeric(row[10]);
  if (!topic || !Number.isFinite(price)) return null;
  const sign = row[11];
  return {
    symbol: topic.appSymbol,
    quote: {
      price,
      change: signedKisValue(sign, row[12]),
      changePct: signedKisValue(sign, row[13]),
      open: parseNumeric(row[7]),
      high: parseNumeric(row[8]),
      low: parseNumeric(row[9]),
      bid: parseNumeric(row[14]),
      ask: parseNumeric(row[15]),
      tradeVolume: parseNumeric(row[18]),
      volume: parseNumeric(row[19]),
      tradeTime: row[6] || row[4],
      tradeDate: row[5] || row[3],
      source: 'kis-ws-overseas',
    },
  };
}

function parseKisRealtimePacket(message) {
  const text = String(message || '');
  if (!text || text[0] !== '0') return [];
  const [encrypted, trId, countText, body] = text.split('|');
  if (encrypted !== '0' || !body) return [];

  const columnCount = KIS_REALTIME_COLUMNS[trId];
  if (!columnCount) return [];

  const count = Number(countText) || 1;
  const values = body.split('^');
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const offset = i * columnCount;
    const row = values.slice(offset, offset + columnCount);
    let parsed = null;
    if (trId === KIS_TR.DOMESTIC_STOCK) parsed = parseKisDomesticStockRow(row);
    if (trId === KIS_TR.DOMESTIC_INDEX) parsed = parseKisDomesticIndexRow(row);
    if (trId === KIS_TR.OVERSEAS_STOCK) parsed = parseKisOverseasStockRow(row);
    if (parsed) rows.push(parsed);
  }
  return rows;
}

async function connectKisRealtime() {
  if (!hasKisConfig()) throw new Error('KIS_APP_KEY/KIS_APP_SECRET missing');
  if (Date.now() < kisRealtimeBlockedUntil) throw new Error('KIS realtime reconnect is temporarily blocked');
  if (kisRealtimeSocket?.readyState === WebSocket.OPEN) return kisRealtimeSocket;
  if (kisRealtimeSocket?.readyState === WebSocket.CONNECTING) return kisRealtimeSocket;
  if (kisRealtimeConnecting) return kisRealtimeConnecting;

  kisRealtimeConnecting = (async () => {
    const approvalKey = await fetchKisApprovalKey();
    const socket = new WebSocket(kisWsUrl());
    kisRealtimeSocket = socket;

    socket.on('open', () => {
      kisReconnectAttempts = 0;
      console.log(`✅ KIS realtime WebSocket connected (${realtimeSymbols.size} symbols)`);
      for (const topic of realtimeSymbols.values()) {
        socket.send(kisSubscribeMessage(approvalKey, topic, '1'));
      }
    });

    socket.on('message', (data) => {
      const text = data.toString();
      if (text[0] === '{') {
        try {
          const json = JSON.parse(text);
          const msg = json?.body?.msg1;
          if (String(msg || '').includes('ALREADY IN USE appkey')) {
            blockKisRealtime(socket);
          } else if (msg && !/SUBSCRIBE SUCCESS/i.test(msg)) console.warn('KIS realtime:', msg);
        } catch {
          // ignore malformed control messages
        }
        return;
      }

      for (const row of parseKisRealtimePacket(text)) {
        broadcastRealtimeQuote(row.symbol, row.quote);
      }
    });

    socket.on('close', () => {
      console.warn('KIS realtime WebSocket closed');
      if (kisRealtimeSocket === socket) {
        kisRealtimeSocket = null;
        scheduleKisReconnect();
      }
    });

    socket.on('error', (e) => {
      console.warn('KIS realtime WebSocket error:', e.message);
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('KIS realtime WebSocket timeout')), 8000);
      socket.once('open', () => { clearTimeout(timeout); resolve(); });
      socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
    });
    return socket;
  })();

  try {
    return await kisRealtimeConnecting;
  } finally {
    kisRealtimeConnecting = null;
  }
}

function registerRealtimeSymbol(symbol) {
  const topic = kisRealtimeTopic(symbol);
  if (!topic) return null;
  const wasSubscribed = realtimeSymbols.has(topic.cacheKey);
  realtimeSymbols.set(topic.cacheKey, topic);

  if (wasSubscribed) return topic;

  if (kisRealtimeSocket?.readyState === WebSocket.OPEN) {
    subscribeKisSymbol(topic.cacheKey);
    return topic;
  }

  if (Date.now() >= kisRealtimeBlockedUntil) {
    connectKisRealtime()
      .catch(e => console.warn(`KIS realtime unavailable [${topic.cacheKey}]:`, e.message));
  }

  return topic;
}

function krxMinuteOfDay(time) {
  if (typeof time !== 'number') return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(time * 1000));
  const hour = Number(parts.find(p => p.type === 'hour')?.value);
  const minute = Number(parts.find(p => p.type === 'minute')?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

function filterKrxRegularMinutes(rows) {
  const open = 9 * 60;
  const auctionStart = 15 * 60 + 21;
  const auctionEnd = 15 * 60 + 29;
  const close = 15 * 60 + 30;
  return rows.filter((row) => {
    const minute = krxMinuteOfDay(row.time);
    if (minute == null) return true;
    if (minute < open || minute > close) return false;
    return minute < auctionStart || minute > auctionEnd;
  });
}

const KRX_INTRADAY_MINUTES = {
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '60m': 60,
  '1h': 60,
};

function kstMinuteTimeToSeconds(value) {
  const text = String(value || '');
  const match = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  return Math.floor(Date.UTC(y, mo - 1, d, h - 9, mi) / 1000);
}

function kstDateBucketToSeconds(dateText, minuteOfDay) {
  const text = String(dateText || '');
  const match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, y, mo, d] = match.map(Number);
  const h = Math.floor(minuteOfDay / 60);
  const mi = minuteOfDay % 60;
  return Math.floor(Date.UTC(y, mo - 1, d, h - 9, mi) / 1000);
}

async function fetchKisAfterHoursMinutes(code) {
  const token = await fetchKisAccessToken();
  if (!token) return [];
  const params = new URLSearchParams({ FID_ETC_CLS_CODE: '', FID_COND_MRKT_DIV_CODE: 'UN', FID_INPUT_ISCD: cleanKoreanCode(code), FID_INPUT_HOUR_1: '200000', FID_PW_DATA_INCU_YN: 'Y' });
  const res = await fetch(`${kisBaseUrl()}/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice?${params}`, { headers: kisHeaders(token, 'FHKST03010200') });
  if (!res.ok) throw new Error(`KIS after-hours minute responded ${res.status}`);
  const date = toKstDateKey();
  return ((await res.json()).output2 || []).map(row => {
    const clock = String(row.stck_cntg_hour || ''); if (!/^\d{6}$/.test(clock) || clock < '160000' || clock > '200000') return null;
    const close = parseNumeric(row.stck_prpr); const open = parseNumeric(row.stck_oprc) ?? close;
    const high = parseNumeric(row.stck_hgpr) ?? Math.max(open, close); const low = parseNumeric(row.stck_lwpr) ?? Math.min(open, close);
    if (close == null || open == null) return null;
    return { time: kstMinuteTimeToSeconds(`${date}${clock.slice(0, 4)}`), open, high, low, close, volume: parseNumeric(row.cntg_vol) ?? 0 };
  }).filter(Boolean);
}

async function fetchKoreanMinuteOhlcv(code, interval, limit, market = 'regular') {
  const intervalMinutes = KRX_INTRADAY_MINUTES[interval] || 1;
  const cacheKey = `krx-minute:${code}:${interval}:${limit}:${market}`;
  const now = Date.now();
  const cached = ohlcvCache.get(cacheKey);
  if (cached && now - cached.ts < KRX_MINUTE_TTL_MS) return cached.data;

  const fetchCount = Math.min(Math.max(limit * intervalMinutes + 300, 600), 3000);
  const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${encodeURIComponent(code)}&timeframe=minute&count=${fetchCount}&requestType=0`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR,ko;q=0.9' } });
  if (!res.ok) throw new Error(`Naver minute responded ${res.status}`);

  const xml = await res.text();
  const minuteRows = [...xml.matchAll(/item data="([^"]+)"/g)]
    .map(m => m[1].split('|'))
    .map((p, idx, arr) => {
      const time = kstMinuteTimeToSeconds(p[0]);
      const close = parseNumeric(p[4]);
      const prevClose = idx > 0 ? parseNumeric(arr[idx - 1]?.[4]) : close;
      const cumulativeVolume = parseNumeric(p[5]);
      const prevCumulativeVolume = idx > 0 ? parseNumeric(arr[idx - 1]?.[5]) : null;
      const volume = Number.isFinite(cumulativeVolume) && Number.isFinite(prevCumulativeVolume)
        ? Math.max(0, cumulativeVolume - prevCumulativeVolume)
        : cumulativeVolume;
      if (time == null || close == null) return null;
      const open = parseNumeric(p[1]) ?? prevClose ?? close;
      const high = parseNumeric(p[2]) ?? Math.max(open, close);
      const low = parseNumeric(p[3]) ?? Math.min(open, close);
      return { time, open, high, low, close, volume };
    })
    .filter(Boolean);

  let regularRows = filterKrxRegularMinutes(minuteRows);
  if (market === 'after') {
    try { regularRows = [...regularRows, ...await fetchKisAfterHoursMinutes(code)].sort((a, b) => a.time - b.time); }
    catch (error) { console.warn(`KIS after-hours minute fallback [${code}]:`, error.message); }
  }
  if (intervalMinutes === 1) {
    const data = regularRows.slice(-limit);
    ohlcvCache.set(cacheKey, { ts: now, data });
    return data;
  }

  const buckets = new Map();
  const openMinute = 9 * 60;
  regularRows.forEach((row) => {
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(row.time * 1000)).replaceAll('-', '');
    const minute = krxMinuteOfDay(row.time);
    if (minute == null) return;
    const bucketMinute = minute >= 16 * 60 ? 16 * 60 + Math.floor((minute - 16 * 60) / intervalMinutes) * intervalMinutes : openMinute + Math.floor((minute - openMinute) / intervalMinutes) * intervalMinutes;
    const bucketTime = kstDateBucketToSeconds(date, bucketMinute);
    if (bucketTime == null) return;
    const current = buckets.get(bucketTime);
    if (!current) {
      buckets.set(bucketTime, { time: bucketTime, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume });
      return;
    }
    current.high = Math.max(current.high, row.high);
    current.low = Math.min(current.low, row.low);
    current.close = row.close;
    current.volume = (Number(current.volume) || 0) + (Number(row.volume) || 0);
  });

  const data = [...buckets.values()].sort((a, b) => a.time - b.time).slice(-limit);
  ohlcvCache.set(cacheKey, { ts: now, data });
  return data;
}

async function fetchUsOhlcv(symbol, interval, limit) {
  const now = Date.now();
  const weeklyKey = interval === 'week' ? symbol : null;
  const weeklyCached = weeklyKey ? weeklyOhlcvCache.get(weeklyKey) : null;
  if (weeklyCached && now - weeklyCached.ts < WEEKLY_OHLCV_CACHE_TTL_MS && weeklyCached.data.length >= limit) {
    return weeklyCached.data.slice(-limit);
  }

  const sourceLimit = weeklyKey ? Math.max(limit, WEEKLY_OHLCV_SOURCE_BARS) : limit;
  const cacheKey = `${symbol}:${interval}:${sourceLimit}`;
  const cached = ohlcvCache.get(cacheKey);
  const ttl = interval === 'day' ? 3000 : KRX_INTRADAY_MINUTES[interval] ? KRX_MINUTE_TTL_MS : ['week', 'month'].includes(interval) ? 3600000 : 300000;
  if (cached && now - cached.ts < ttl) return weeklyKey ? cached.data.slice(-limit) : cached.data;

  const intervalMap = {
    '1m': '1m', '3m': '5m', '5m': '5m', '10m': '10m',
    '15m': '15m', '30m': '30m', '60m': '1h', '1h': '1h',
    day: '1d', week: '1wk', month: '1mo',
  };
  const yInterval = intervalMap[interval] || '1d';
  const daysPerBar = { '1m': 1 / 390, '3m': 5 / 390, '5m': 5 / 390, '15m': 15 / 390, '30m': 0.1, '60m': 0.2, '1h': 0.2, day: 1, week: 7, month: 30 };
  const daysPer = daysPerBar[interval] || 1;
  // Weekly data already arrives as complete bars; 1.4x covers holidays and
  // indicator history without fetching decades of unnecessary daily history.
  const historyMultiplier = interval === 'week' ? 1.4 : 2.5;
  const daysBack = Math.ceil(sourceLimit * daysPer * historyMultiplier) + 14;
  const maxDays = { '1m': 7, '3m': 14, '5m': 59, '15m': 59, '30m': 59, '60m': 59, '1h': 59 };
  const actualDays = Math.min(daysBack, maxDays[interval] || daysBack);
  const period1 = new Date(Date.now() - actualDays * 24 * 3600000).toISOString().slice(0, 10);
  const fallbackIntervalFor = (value) => value === '1m' ? '5m'
    : value === '3m' ? '5m'
      : value === '5m' ? '15m'
        : value === '15m' ? '30m'
          : value === '30m' ? '60m'
            : 'day';

  let result;
  try {
    if (weeklyKey) {
      const pending = weeklyOhlcvInFlight.get(weeklyKey);
      if (pending) {
        result = await pending;
      } else {
        const request = yahooFinance.chart(symbol, { period1, interval: yInterval });
        weeklyOhlcvInFlight.set(weeklyKey, request);
        try {
          result = await request;
        } finally {
          weeklyOhlcvInFlight.delete(weeklyKey);
        }
      }
    } else {
      result = await yahooFinance.chart(symbol, { period1, interval: yInterval });
    }
  } catch (e) {
    if (['1m', '3m', '5m', '15m', '30m', '60m', '1h'].includes(interval)) {
      const fallbackInterval = fallbackIntervalFor(interval);
      return fetchUsOhlcv(symbol, fallbackInterval, limit);
    }
    throw e;
  }
  const quotes = (result.quotes || [])
    .map(q => {
      const d = new Date(q.date);
      const time = ['1d', '1wk', '1mo'].includes(yInterval) ? d.toISOString().slice(0, 10) : Math.floor(d.getTime() / 1000);
      return { time, open: q.open ?? null, high: q.high ?? null, low: q.low ?? null, close: q.close ?? null, volume: q.volume ?? null };
    })
    .filter(x => x.open !== null && x.close !== null && x.high !== null && x.low !== null)
    .slice(-sourceLimit);

  if (!quotes.length && ['1m', '3m', '5m', '15m', '30m', '60m', '1h'].includes(interval)) {
    return fetchUsOhlcv(symbol, fallbackIntervalFor(interval), limit);
  }

  if (weeklyKey) {
    weeklyOhlcvCache.set(weeklyKey, { ts: now, data: quotes });
    return quotes.slice(-limit);
  }
  ohlcvCache.set(cacheKey, { ts: now, data: quotes });
  return quotes;
}

function toKstDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date).replaceAll('-', '');
}

function shiftKoreanDate(dateKey, days) {
  const date = new Date(Date.UTC(Number(dateKey.slice(0, 4)), Number(dateKey.slice(4, 6)) - 1, Number(dateKey.slice(6, 8))));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

function normalizeKoreanDailyRows(rows) {
  const byDate = new Map();
  (rows || []).forEach((row) => {
    const date = String(row.date || row.stck_bsop_date || '').replace(/\D/g, '');
    const open = parseNumeric(row.open ?? row.stck_oprc);
    const high = parseNumeric(row.high ?? row.stck_hgpr);
    const low = parseNumeric(row.low ?? row.stck_lwpr);
    const close = parseNumeric(row.close ?? row.stck_clpr);
    const volume = parseNumeric(row.volume ?? row.acml_vol) ?? 0;
    if (/^\d{8}$/.test(date) && open != null && high != null && low != null && close != null) byDate.set(date, { date, open, high, low, close, volume });
  });
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchNaverSignalHistory(code, count = 500) {
  const cleanCode = cleanKoreanCode(code);
  if (!/^\d{6}$/.test(cleanCode)) throw new Error('Korean 6-digit symbol required');
  const limit = Math.max(120, Math.min(500, Number(count) || 500));
  const res = await fetch(`https://fchart.stock.naver.com/sise.nhn?symbol=${encodeURIComponent(cleanCode)}&timeframe=day&count=${limit}&requestType=0`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR,ko;q=0.9' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Naver signal history responded ${res.status}`);
  const xml = await res.text();
  const rows = normalizeKoreanDailyRows([...xml.matchAll(/item data="([^"]+)"/g)].map(match => {
    const item = match[1].split('|');
    return { date: item[0], open: item[1], high: item[2], low: item[3], close: item[4], volume: item[5] };
  })).slice(-limit);
  if (!rows.length) throw new Error('Naver signal history returned no rows');
  return rows;
}

async function fetchNaverDailyHistory(code, calendarDays) {
  const count = Math.min(Math.max(Math.ceil(calendarDays * 0.75) + 300, 600), 2500);
  const res = await fetch(`https://fchart.stock.naver.com/sise.nhn?symbol=${encodeURIComponent(code)}&timeframe=day&count=${count}&requestType=0`, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR,ko;q=0.9' } });
  if (!res.ok) throw new Error(`Naver responded ${res.status}`);
  const xml = await res.text();
  return normalizeKoreanDailyRows([...xml.matchAll(/item data="([^"]+)"/g)].map(match => {
    const item = match[1].split('|');
    return { date: item[0], open: item[1], high: item[2], low: item[3], close: item[4], volume: item[5] };
  }));
}

async function fetchKisDailyHistory(code, calendarDays) {
  const cleanCode = cleanKoreanCode(code);
  const end = toKstDateKey();
  const start = shiftKoreanDate(end, -calendarDays);
  const cached = koreanDailyHistoryCache.get(cleanCode);
  if (cached && Date.now() - cached.ts < WEEKLY_OHLCV_CACHE_TTL_MS && cached.rows[0]?.date <= start) return cached.rows;
  const pending = koreanDailyHistoryInFlight.get(cleanCode);
  if (pending) {
    const rows = await pending;
    if (rows[0]?.date <= start) return rows;
  }
  const request = (async () => {
    const token = await fetchKisAccessToken();
    if (!token) throw new Error('KIS history unavailable');
    const byDate = new Map(cached?.rows?.map(row => [row.date, row]) || []);
    let pageEnd = end;
    for (let page = 0; page < KIS_HISTORY_MAX_PAGES && pageEnd >= start; page += 1) {
      const pageStart = pageEnd > shiftKoreanDate(start, KIS_HISTORY_PAGE_DAYS) ? shiftKoreanDate(pageEnd, -KIS_HISTORY_PAGE_DAYS) : start;
      const params = new URLSearchParams({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: cleanCode, FID_INPUT_DATE_1: pageStart, FID_INPUT_DATE_2: pageEnd, FID_PERIOD_DIV_CODE: 'D', FID_ORG_ADJ_PRC: '0' });
      const res = await fetch(`${kisBaseUrl()}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?${params}`, { headers: kisHeaders(token, 'FHKST03010100') });
      if (!res.ok) throw new Error(`KIS daily history responded ${res.status}`);
      const pageRows = normalizeKoreanDailyRows((await res.json()).output2 || []);
      if (!pageRows.length) break;
      pageRows.forEach(row => byDate.set(row.date, row));
      if (pageRows[0].date >= pageEnd) break;
      pageEnd = shiftKoreanDate(pageRows[0].date, -1);
    }
    const rows = normalizeKoreanDailyRows([...byDate.values()]);
    if (!rows.length) throw new Error('KIS daily history returned no rows');
    koreanDailyHistoryCache.set(cleanCode, { ts: Date.now(), rows });
    return rows;
  })();
  koreanDailyHistoryInFlight.set(cleanCode, request);
  try { return await request; } finally { koreanDailyHistoryInFlight.delete(cleanCode); }
}

function aggregateKoreanOhlcv(rows, interval) {
  const bars = new Map();
  normalizeKoreanDailyRows(rows).forEach(row => {
    const date = new Date(`${row.date.slice(0, 4)}-${row.date.slice(4, 6)}-${row.date.slice(6, 8)}T00:00:00Z`);
    if (interval === 'week') date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() || 7) - 1));
    else date.setUTCDate(1);
    const time = date.toISOString().slice(0, 10);
    const current = bars.get(time);
    if (!current) bars.set(time, { time, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume });
    else { current.high = Math.max(current.high, row.high); current.low = Math.min(current.low, row.low); current.close = row.close; current.volume += row.volume; }
  });
  return [...bars.values()].sort((a, b) => a.time.localeCompare(b.time));
}

async function fetchKoreanLongOhlcv(code, interval, limit) {
  const sourceLimit = interval === 'week' ? Math.max(limit, WEEKLY_OHLCV_SOURCE_BARS) : limit;
  const key = `kr:${interval}:${cleanKoreanCode(code)}`;
  const cached = weeklyOhlcvCache.get(key);
  if (cached && Date.now() - cached.ts < WEEKLY_OHLCV_CACHE_TTL_MS && cached.data.length >= limit) return cached.data.slice(-limit);
  const pending = weeklyOhlcvInFlight.get(key);
  if (pending) return (await pending).slice(-limit);
  const request = (async () => {
    const calendarDays = interval === 'week' ? sourceLimit * 7 + 180 : sourceLimit * 32 + 120;
    let rows; let source = 'KIS';
    try { rows = await fetchKisDailyHistory(code, calendarDays); }
    catch { source = 'Naver'; rows = await fetchNaverDailyHistory(cleanKoreanCode(code), calendarDays); }
    const data = aggregateKoreanOhlcv(rows, interval).slice(-sourceLimit);
    if (!data.length) throw new Error(`${source} ${interval}ly history returned no bars`);
    weeklyOhlcvCache.set(key, { ts: Date.now(), data });
    const logKey = `${source}:${key}`;
    if (Date.now() - (koreanOhlcvLogAt.get(logKey) || 0) > 60_000) { koreanOhlcvLogAt.set(logKey, Date.now()); console.info(`${source} ${interval}ly OHLCV loaded [${cleanKoreanCode(code)}]: ${data.length} bars`); }
    return data;
  })();
  weeklyOhlcvInFlight.set(key, request);
  try { return (await request).slice(-limit); } finally { weeklyOhlcvInFlight.delete(key); }
}

async function fetchKoreanOhlcv(code, interval, limit, { market = 'regular' } = {}) {
  const normalizedInterval = interval === '1h' ? '60m' : interval;
  const cleanCode = cleanKoreanCode(code);
  if (normalizedInterval === 'week' || normalizedInterval === 'month') return fetchKoreanLongOhlcv(cleanCode, normalizedInterval, limit);
  if (interval !== 'day') {
    if (KRX_INTRADAY_MINUTES[normalizedInterval]) {
      return fetchKoreanMinuteOhlcv(cleanCode, normalizedInterval, limit, market);
    }
    const suffix = code.endsWith('.KS') || code.endsWith('.KQ') ? code : `${code}.KS`;
    try {
      return filterKrxRegularMinutes(await fetchUsOhlcv(suffix, normalizedInterval, limit));
    } catch (e) {
      console.warn(`Intraday fetch failed for ${suffix} ${interval}:`, e.message);
      if (normalizedInterval === '5m') return filterKrxRegularMinutes(await fetchUsOhlcv(suffix, '15m', limit));
      if (normalizedInterval === '15m') return filterKrxRegularMinutes(await fetchUsOhlcv(suffix, '30m', limit));
      if (normalizedInterval === '30m') return filterKrxRegularMinutes(await fetchUsOhlcv(suffix, '60m', limit));
      return fetchUsOhlcv(suffix, 'day', limit);
    }
  }
  try {
    const rows = await fetchKisDailyHistory(cleanCode, Math.max(Math.ceil(limit * 1.7) + 60, 365));
    return rows.slice(-limit);
  } catch {
    // Public fallback below keeps Vercel and KIS-unavailable environments working.
  }
  const fetchCount = Math.min(limit + 300, 2500);
  const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${encodeURIComponent(code)}&timeframe=day&count=${fetchCount}&requestType=0`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR,ko;q=0.9' } });
  if (!res.ok) throw new Error(`Naver responded ${res.status}`);
  const xml = await res.text();
  const rows = [...xml.matchAll(/item data="([^"]+)"/g)]
    .map(m => m[1].split('|'))
    .map(p => ({
      date: p[0],
      open: parseNumeric(p[1]),
      high: parseNumeric(p[2]),
      low: parseNumeric(p[3]),
      close: parseNumeric(p[4]),
      volume: parseNumeric(p[5]),
    }))
    .filter(x => x.open !== null && x.close !== null);
  return rows.slice(-limit);
}

app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 1) return res.json([]);
    const query = q.trim().toLowerCase();
    const upperQ = q.trim().toUpperCase().replace(/\s/g, '');
    const isKoreanQuery = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(query);
    const indexMatches = Object.entries(INDEX_MAP)
      .filter(([key]) => key.includes(upperQ) || upperQ.includes(key.slice(0, 3)))
      .map(([, v]) => ({ symbol: v.symbol, name: v.name, exchange: v.exchange, type: 'INDEX' }));
    const naverMatches = isKoreanQuery ? await fetch(`https://ac.stock.naver.com/ac?q=${encodeURIComponent(q.trim())}&type=search&target=stock`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR,ko;q=0.9' },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Naver search responded ${response.status}`);
        const payload = await response.json();
        return (payload.items || [])
          .filter((item) => item?.category === 'stock' && /^\d{6}$/.test(String(item.code || '')))
          .map((item) => {
            const exchange = String(item.typeCode || '').toUpperCase() === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI';
            return { symbol: `${item.code}.${exchange === 'KOSDAQ' ? 'KQ' : 'KS'}`, name: item.name, exchange, type: 'KR' };
          });
      })
      .catch(() => []) : [];
    const krxList = isKoreanQuery && !krxCache.items.length
      ? KRX_FALLBACK_ITEMS
      : await loadKrxList().catch(() => []);
    if (isKoreanQuery && !krxCache.items.length) {
      loadKrxList().catch(() => {});
    }
    const krxMatches = krxList
      .map(x => ({ item: x, score: krxSearchScore(x, query) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name, 'ko'))
      .slice(0, 15)
      .map(({ item }) => ({ symbol: `${item.code}.${item.marketType === '코스닥' ? 'KQ' : 'KS'}`, name: item.name, exchange: item.marketType === '코스닥' ? 'KOSDAQ' : 'KOSPI', type: 'KR' }));
    let usMatches = [];
    if (!isKoreanQuery) {
      try {
        const result = await yahooFinance.search(q, { quotesCount: 10 });
        usMatches = (result.quotes || [])
          .filter(x => ['EQUITY', 'ETF', 'INDEX', 'FUTURE'].includes(x.quoteType) && !x.symbol.match(/\.(KS|KQ|T|HK|AX)$/))
          .slice(0, 10)
          .map(x => ({ symbol: x.symbol, name: x.shortname || x.longname || x.symbol, exchange: x.exchange || 'US', type: x.quoteType === 'INDEX' ? 'INDEX' : 'US' }));
      } catch (e) {
        console.error('Yahoo search error:', e.message);
      }
    }
    const seen = new Set();
    return res.json([...indexMatches, ...naverMatches, ...krxMatches, ...usMatches].filter((item) => {
      if (!item?.symbol || seen.has(item.symbol)) return false;
      seen.add(item.symbol);
      return true;
    }));
  } catch (e) {
    console.error('Search error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/signal-history', async (req, res) => {
  try {
    const { symbol, limit = 500 } = req.query;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const code = String(symbol).replace(/\.(KS|KQ)$/i, '');
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Korean 6-digit symbol required' });
    const data = await fetchNaverSignalHistory(code, limit);
    res.set('Cache-Control', 'no-store');
    return res.json(data);
  } catch (e) {
    console.error(`Signal history error [${req.query.symbol}]:`, e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/ohlcv', async (req, res) => {
  try {
    const { symbol, interval = 'day', limit = 300, market = 'regular' } = req.query;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const lim = Math.min(Number(limit) || 300, 2000);
    let data;
    const isKorean = /^\d{6}$/.test(symbol) || symbol.endsWith('.KS') || symbol.endsWith('.KQ');
    const isIndex = symbol.startsWith('^');
    const code = symbol.replace(/\.(KS|KQ)$/, '');
    if (isIndex) data = await fetchUsOhlcv(symbol, interval, lim);
    else if (isKorean && interval === 'day') {
      data = await fetchKoreanOhlcv(code, interval, lim, { market });
      data = data.map(x => ({ ...x, time: x.date ? x.date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : x.time }));
    } else if (isKorean) data = await fetchKoreanOhlcv(code, interval, lim, { market });
    else data = await fetchUsOhlcv(symbol, interval, lim);
    const seen = new Set();
    data = data.filter(d => { if (seen.has(d.time)) return false; seen.add(d.time); return true; }).sort((a, b) => (a.time > b.time ? 1 : -1));
    return res.json(data);
  } catch (e) {
    console.error(`OHLCV error [${req.query.symbol}]:`, e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/quote', async (req, res) => {
  try {
    const { symbol, market = 'regular' } = req.query;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const quote = await fetchRealtimeQuote(symbol, market === 'after' ? 'after' : 'regular');
    if (!quote) return res.status(404).json({ error: 'quote not found' });
    return res.json(quote);
  } catch (e) {
    console.error(`Quote error [${req.query.symbol}]:`, e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/stream/quote', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  const topic = kisRealtimeTopic(symbol);
  if (!topic) return res.status(400).json({ error: 'KIS realtime does not support this symbol' });

  const id = `${topic.cacheKey}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  sendSse(res, 'ready', {
    symbol: topic.cacheKey,
    kind: topic.kind,
    trId: topic.trId,
    trKey: topic.trKey,
    kisConfigured: hasKisConfig(),
    source: hasKisConfig() ? 'kis-ws' : 'fallback',
    realtimeStatus: Date.now() < kisRealtimeBlockedUntil ? 'waiting' : 'connecting',
  });

  realtimeClients.set(id, { symbol: topic.cacheKey, res });
  const latest = realtimeQuotes.get(topic.cacheKey);
  if (latest) sendSse(res, 'quote', latest);
  registerRealtimeSymbol(symbol);

  const heartbeat = setInterval(() => {
    try {
      sendSse(res, 'heartbeat', { ts: Date.now() });
    } catch {
      clearInterval(heartbeat);
      realtimeClients.delete(id);
    }
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    realtimeClients.delete(id);
    if (!hasRealtimeClientForSymbol(topic.cacheKey)) unsubscribeKisSymbol(topic.cacheKey);
  });
});

app.post('/api/analyze', async (req, res) => {
  try {
    const result = await analyzeCharts(req.body);
    return res.json({ result });
  } catch (e) {
    console.error('Analyze error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

const distDir = new URL('../dist/', import.meta.url);
const indexHtml = new URL('../dist/index.html', import.meta.url);

if (existsSync(distDir)) {
  // HTML must always be revalidated so a deployment never leaves a stale app
  // shell in a normal browser cache. Vite assets are content-hashed, so they
  // can safely be cached for a year without delaying a new deployment.
  app.use(express.static(distDir.pathname, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('/index.html')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      } else if (filePath.includes('/assets/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
    },
  }));
  app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(indexHtml.pathname);
  });
}

if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`✅ Backend server listening on http://localhost:${PORT}`);
  });
}

export default app;
