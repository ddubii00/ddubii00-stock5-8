import { INDEX_MAP, loadKrxList, yahooFinance } from './_shared.js';

const KOREAN_SEARCH_FALLBACKS = [
  ['005930', '삼성전자', 'KOSPI'],
  ['005935', '삼성전자우', 'KOSPI'],
  ['006400', '삼성SDI', 'KOSPI'],
  ['009150', '삼성전기', 'KOSPI'],
  ['028260', '삼성물산', 'KOSPI'],
  ['207940', '삼성바이오로직스', 'KOSPI'],
  ['010140', '삼성중공업', 'KOSPI'],
  ['032830', '삼성생명', 'KOSPI'],
  ['000810', '삼성화재', 'KOSPI'],
  ['016360', '삼성증권', 'KOSPI'],
  ['029780', '삼성카드', 'KOSPI'],
  ['018260', '삼성에스디에스', 'KOSPI'],
  ['028050', '삼성E&A', 'KOSPI'],
].map(([code, name, exchange]) => ({ symbol: `${code}.${exchange === 'KOSDAQ' ? 'KQ' : 'KS'}`, name, exchange, type: 'KR' }));

function resolveSearchWithin(promise, fallback = [], timeoutMs = 1200) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

function normalizeKoreanResult(item) {
  const code = String(item?.itemCode || item?.code || item?.symbol || '').replace(/\.(KS|KQ)$/i, '');
  const name = item?.stockName || item?.name || item?.itemName || '';
  if (!/^\d{6}$/.test(code) || !name) return null;
  const market = String(item?.typeCode || item?.stockExchangeType || item?.marketType || item?.exchange || '').toUpperCase();
  const exchange = market.includes('KOSDAQ') ? 'KOSDAQ' : 'KOSPI';
  return { symbol: `${code}.${exchange === 'KOSDAQ' ? 'KQ' : 'KS'}`, name, exchange, type: 'KR' };
}

async function fetchNaverStockMatches(query) {
  const response = await fetch(`https://ac.stock.naver.com/ac?q=${encodeURIComponent(query)}&type=search&target=stock`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR,ko;q=0.9' },
  });
  if (!response.ok) throw new Error(`Naver search responded ${response.status}`);
  const payload = await response.json();
  const items = payload?.items || payload?.stockList || payload?.stocks || payload?.result?.stockList || [];
  return items
    .filter((item) => !item?.category || item.category === 'stock')
    .map(normalizeKoreanResult)
    .filter(Boolean);
}

function uniqueMatches(matches) {
  const seen = new Set();
  return matches.filter((item) => {
    if (!item?.symbol || seen.has(item.symbol)) return false;
    seen.add(item.symbol);
    return true;
  });
}

export default async function handler(req, res) {
  const { q } = req.query;
  if (!q || q.trim().length < 1) return res.json([]);
  const query = q.trim().toLowerCase();
  const upperQuery = q.trim().toUpperCase().replace(/\s/g, '');
  const isKoreanQuery = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(query);

  const indexMatches = Object.entries(INDEX_MAP)
    .filter(([key, value]) => key.includes(upperQuery) || value.name.toUpperCase().includes(upperQuery))
    .map(([, value]) => ({ symbol: value.symbol, name: value.name, exchange: value.exchange, type: 'INDEX' }));

  const [naverMatches, krxList] = isKoreanQuery
    ? await Promise.all([
        resolveSearchWithin(fetchNaverStockMatches(q.trim())),
        resolveSearchWithin(loadKrxList()),
      ])
    : [[], []];
  const fallbackMatches = KOREAN_SEARCH_FALLBACKS.filter((item) => (
    item.name.toLowerCase().includes(query) || item.symbol.includes(query)
  ));
  const krxMatches = (krxList || [])
    .filter((item) => item.name.toLowerCase().includes(query) || item.code.includes(query))
    .slice(0, 15)
    .map((item) => ({
      symbol: `${item.code}.${item.marketType === '코스닥' ? 'KQ' : 'KS'}`,
      name: item.name,
      exchange: item.marketType === '코스닥' ? 'KOSDAQ' : 'KOSPI',
      type: 'KR',
    }));

  const usMatches = isKoreanQuery
    ? []
    : await resolveSearchWithin(
        yahooFinance.search(q.trim(), { quotesCount: 10 })
          .then((result) => (result.quotes || [])
            .filter((item) => ['EQUITY', 'ETF', 'INDEX', 'FUTURE'].includes(item.quoteType) && !item.symbol.match(/\.(KS|KQ|T|HK|AX)$/))
            .slice(0, 10)
            .map((item) => ({
              symbol: item.symbol,
              name: item.shortname || item.longname || item.symbol,
              exchange: item.exchange || 'US',
              type: item.quoteType === 'INDEX' ? 'INDEX' : 'US',
            }))),
      );

  return res.json(uniqueMatches([...indexMatches, ...naverMatches, ...krxMatches, ...fallbackMatches, ...usMatches]).slice(0, 25));
}
