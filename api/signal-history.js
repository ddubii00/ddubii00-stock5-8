function number(value) {
  const parsed = Number(String(value ?? '').replaceAll(',', '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanCode(symbol) {
  return String(symbol || '').replace(/\.(KS|KQ)$/i, '');
}

async function fetchNaverSignalHistory(symbol, count = 500) {
  const code = cleanCode(symbol);
  if (!/^\d{6}$/.test(code)) throw new Error('Korean 6-digit symbol required');
  const limit = Math.max(120, Math.min(500, Number(count) || 500));
  const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${encodeURIComponent(code)}&timeframe=day&count=${limit}&requestType=0`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Naver signal history responded ${response.status}`);
  const xml = await response.text();
  const byDate = new Map();
  for (const match of xml.matchAll(/item data="([^"]+)"/g)) {
    const parts = match[1].split('|');
    if (parts.length < 6) continue;
    const [date, open, high, low, close, volume] = parts;
    const row = { date, open: number(open), high: number(high), low: number(low), close: number(close), volume: number(volume) };
    if (/^\d{8}$/.test(date) && [row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite)) byDate.set(date, row);
  }
  const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-limit);
  if (!rows.length) throw new Error('Naver signal history returned no rows');
  return rows;
}

export default async function handler(req, res) {
  try {
    const { symbol, limit = 500 } = req.query;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const rows = await fetchNaverSignalHistory(symbol, limit);
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=300');
    return res.json(rows);
  } catch (error) {
    console.error(`Signal history error [${req.query?.symbol}]:`, error.message);
    return res.status(500).json({ error: error.message });
  }
}
