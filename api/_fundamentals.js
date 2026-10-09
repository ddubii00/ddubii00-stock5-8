const CACHE_TTL_MS = 60 * 60 * 1000;
const RETRY_TTL_MS = 5 * 60 * 1000;

function numeric(value) {
  if (value == null) return null;
  const text = String(value).replaceAll(',', '').replace(/(?:배|원|%)$/g, '').trim();
  if (!text || !/^[+-]?\d+(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function koreanAmount(value) {
  const text = String(value || '').replaceAll(',', '');
  const units = { 조: 1e12, 억: 1e8, 만: 1e4 };
  const parts = [...text.matchAll(/([\d.]+)\s*(조|억|만)/g)];
  return parts.length ? parts.reduce((sum, [, amount, unit]) => sum + Number(amount) * units[unit], 0) : numeric(value);
}

function fiscalDate(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

export function normalizeNaverFundamentals(symbol, integration, annual) {
  const info = Object.fromEntries((integration?.totalInfos || []).map(item => [item.code, item]));
  const finance = annual?.financeInfo || {};
  const periods = [...(finance.trTitleList || [])].sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const actual = periods.filter(period => period.isConsensus === 'N').at(-1);
  const forecast = periods.find(period => period.isConsensus === 'Y' && (!actual || String(period.key) > String(actual.key)));
  const rows = Object.fromEntries((finance.rowList || []).map(row => [row.title, row.columns]));
  const annualValue = (name, period) => numeric(rows[name]?.[period?.key]?.value);
  const per = numeric(info.per?.value);
  const actualEps = annualValue('EPS', actual);
  const forecastEps = annualValue('EPS', forecast);
  const growthPct = actualEps > 0 && forecastEps > actualEps ? (forecastEps / actualEps - 1) * 100 : null;
  return {
    symbol, source: 'naver', currency: 'KRW', financialCurrency: 'KRW',
    per,
    forwardPer: annualValue('PER', forecast) ?? numeric(info.cnsPer?.value),
    roe: annualValue('ROE', actual),
    forwardRoe: annualValue('ROE', forecast),
    pbr: numeric(info.pbr?.value),
    // PEG* is an estimate using the forecast annual EPS growth, not a vendor PEG.
    peg: per > 0 && growthPct > 0 ? per / growthPct : null,
    pegBasis: 'PER ÷ 예상 연간 EPS 증가율(%) (증가율이 양수인 경우만)',
    marketCap: koreanAmount(info.marketValue?.value),
    revenue: annualValue('매출액', actual) == null ? null : annualValue('매출액', actual) * 1e8,
    operatingIncome: annualValue('영업이익', actual) == null ? null : annualValue('영업이익', actual) * 1e8,
    fiscalPeriod: actual?.title || null,
    forecastPeriod: forecast?.title || null,
    valuationPeriod: info.per?.valueDesc || null,
  };
}

export function normalizeYahooFundamentals(symbol, summary, annual = []) {
  const detail = summary.summaryDetail || {};
  const stats = summary.defaultKeyStatistics || {};
  const financial = summary.financialData || {};
  const statement = [...annual].filter(row => row.totalRevenue != null || row.operatingIncome != null)
    .sort((a, b) => Number(a.date) - Number(b.date)).at(-1);
  const roe = numeric(financial.returnOnEquity);
  return {
    symbol, source: 'yahoo', currency: summary.price?.currency || null,
    financialCurrency: financial.financialCurrency || summary.price?.currency || null,
    per: numeric(detail.trailingPE) ?? numeric(stats.trailingPE),
    forwardPer: numeric(detail.forwardPE) ?? numeric(stats.forwardPE),
    roe: roe == null ? null : roe * 100,
    forwardRoe: null, // No forecast ROE is supplied; do not infer it from PER/PBR.
    pbr: numeric(stats.priceToBook), peg: numeric(stats.pegRatio), pegBasis: 'Yahoo Finance 제공 PEG',
    marketCap: numeric(detail.marketCap) ?? numeric(summary.price?.marketCap),
    revenue: numeric(statement?.totalRevenue) ?? numeric(financial.totalRevenue),
    operatingIncome: numeric(statement?.operatingIncome),
    fiscalPeriod: fiscalDate(statement?.date) || '최근 12개월',
    forecastPeriod: null,
  };
}

// One shared loader for Oracle and Vercel, separate from quote polling / KIS.
export function createFundamentalsLoader({ yahooFinance, fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const readNaver = async (url) => {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error('재무정보 제공처 응답 오류');
    return response.json();
  };

  return async function loadFundamentals(input) {
    const symbol = String(input || '').trim().toUpperCase();
    if (!symbol || symbol.length > 40 || !/^[A-Z0-9.^=-]+$/.test(symbol)) throw new Error('invalid symbol');
    if (symbol.startsWith('^') || symbol.includes('=')) return { symbol, source: null };
    const cached = cache.get(symbol);
    if (cached && cached.expiresAt > now()) return cached.data;
    if (inFlight.has(symbol)) return inFlight.get(symbol);
    const pending = (async () => {
      try {
        let data;
        const match = symbol.match(/^(\d{6})(?:\.(?:KS|KQ))?$/);
        if (match) {
          const base = `https://m.stock.naver.com/api/stock/${match[1]}`;
          const responses = await Promise.allSettled([readNaver(`${base}/integration`), readNaver(`${base}/finance/annual`)]);
          if (responses.every(response => response.status === 'rejected')) throw new Error('재무정보를 불러올 수 없습니다.');
          data = normalizeNaverFundamentals(symbol,
            responses[0].status === 'fulfilled' ? responses[0].value : null,
            responses[1].status === 'fulfilled' ? responses[1].value : null);
          cache.set(symbol, { data, expiresAt: now() + (responses.some(response => response.status === 'rejected') ? RETRY_TTL_MS : CACHE_TTL_MS) });
        } else {
          const options = { fetchOptions: { signal: AbortSignal.timeout(10_000) } };
          const [summary, annual] = await Promise.allSettled([
            yahooFinance.quoteSummary(symbol, {
              modules: ['price', 'summaryDetail', 'defaultKeyStatistics', 'financialData'],
            }, options),
            yahooFinance.fundamentalsTimeSeries(symbol, {
              period1: new Date(now() - 2 * 366 * 86400_000), type: 'annual', module: 'financials',
            }, options),
          ]);
          if (summary.status === 'rejected' && annual.status === 'rejected') throw new Error('재무정보를 불러올 수 없습니다.');
          data = normalizeYahooFundamentals(symbol, summary.status === 'fulfilled' ? summary.value : {}, annual.status === 'fulfilled' ? annual.value : []);
          cache.set(symbol, { data, expiresAt: now() + CACHE_TTL_MS });
        }
        return data;
      } catch {
        // Keep last known fundamentals during outages, and avoid retry storms.
        const data = cached?.data ? { ...cached.data, stale: true } : { symbol, source: null, unavailable: true };
        cache.set(symbol, { data, expiresAt: now() + RETRY_TTL_MS });
        return data;
      } finally {
        inFlight.delete(symbol);
      }
    })();
    inFlight.set(symbol, pending);
    return pending;
  };
}
