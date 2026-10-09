import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFundamentalsLoader, normalizeNaverFundamentals, normalizeYahooFundamentals } from '../api/_fundamentals.js';
import { formatRatio, formatFundamentalAmount } from '../src/utils/fundamentalFormat.js';

const integration = { totalInfos: [
  { code: 'per', value: '11.80배', valueDesc: '2026.06.' },
  { code: 'cnsPer', value: '5.79배' }, { code: 'pbr', value: '3.06배' },
  { code: 'marketValue', value: '1,537조 5,713억' },
] };
const annual = { financeInfo: {
  trTitleList: [
    { key: '202612', title: '2026.12.', isConsensus: 'Y' },
    { key: '202412', title: '2024.12.', isConsensus: 'N' },
    { key: '202512', title: '2025.12.', isConsensus: 'N' },
  ],
  rowList: [
    { title: 'ROE', columns: { '202512': { value: '10.85' }, '202612': { value: '53.49' } } },
    { title: 'PER', columns: { '202612': { value: '5.77' } } },
    { title: 'EPS', columns: { '202512': { value: '6,564' }, '202612': { value: '45,419' } } },
    { title: '매출액', columns: { '202512': { value: '3,336,059' } } },
    { title: '영업이익', columns: { '202512': { value: '436,011' } } },
  ],
} };

test('Korean metrics use actual and forecast periods, and correct won units', () => {
  const data = normalizeNaverFundamentals('005930.KS', integration, annual);
  assert.equal(data.per, 11.8);
  assert.equal(data.forwardPer, 5.77);
  assert.equal(data.roe, 10.85);
  assert.equal(data.forwardRoe, 53.49);
  assert.equal(data.pbr, 3.06);
  assert.equal(data.fiscalPeriod, '2025.12.');
  assert.equal(data.forecastPeriod, '2026.12.');
  assert.equal(formatRatio(data.peg), '0.02');
  assert.equal(formatFundamentalAmount(data.marketCap, 'KRW'), '1,538조원');
  assert.equal(formatFundamentalAmount(data.revenue, 'KRW'), '334조원');
  assert.equal(formatFundamentalAmount(data.operatingIncome, 'KRW'), '43.6조원');
});

test('missing metrics are not zero and negative profit is preserved', () => {
  const data = normalizeNaverFundamentals('123456.KQ', null, null);
  assert.equal(data.per, null);
  assert.equal(data.forwardRoe, null);
  assert.equal(data.peg, null);
  assert.equal(formatRatio(null), '—');
  assert.equal(formatFundamentalAmount(null, 'KRW'), '—');
  assert.equal(formatFundamentalAmount(-123e8, 'KRW'), '-123억원');
  assert.equal(formatFundamentalAmount(0, 'KRW'), '0원');
});

test('PEG is unavailable when annual EPS growth is not positive', () => {
  const modified = structuredClone(annual);
  modified.financeInfo.rowList.find(row => row.title === 'EPS').columns['202612'].value = '1,000';
  assert.equal(normalizeNaverFundamentals('005930.KS', integration, modified).peg, null);
});

test('Yahoo percentage and annual income units remain separate from price currency', () => {
  const data = normalizeYahooFundamentals('TEST', {
    price: { currency: 'USD' }, summaryDetail: { trailingPE: 20, forwardPE: 15, marketCap: 100e9 },
    defaultKeyStatistics: { priceToBook: 3, pegRatio: 1.2 },
    financialData: { financialCurrency: 'JPY', returnOnEquity: .12, totalRevenue: 55e9 },
  }, [{ date: 1703980800, totalRevenue: 50e9, operatingIncome: 5e9 }]);
  assert.equal(data.roe, 12);
  assert.equal(data.forwardRoe, null);
  assert.equal(data.revenue, 50e9);
  assert.equal(data.operatingIncome, 5e9);
  assert.equal(data.currency, 'USD');
  assert.equal(data.financialCurrency, 'JPY');
  assert.equal(data.fiscalPeriod, '2023-12-31');
  const dated = normalizeYahooFundamentals('TEST', {}, [{ date: new Date('2025-09-30'), totalRevenue: 123 }]);
  assert.equal(dated.fiscalPeriod, '2025-09-30');
});

test('loader shares in-flight requests and caches by symbol for an hour', async () => {
  let calls = 0;
  let clock = 0;
  const load = createFundamentalsLoader({ now: () => clock, fetchImpl: async (url) => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return { ok: true, json: async () => url.endsWith('/annual') ? annual : integration };
  } });
  const [first, second] = await Promise.all([load('005930.KS'), load('005930.KS')]);
  assert.equal(first, second);
  assert.equal(calls, 2);
  await load('005930.KS');
  assert.equal(calls, 2);
  clock = 3600_001;
  await load('005930.KS');
  assert.equal(calls, 4);
});

test('partial provider failure retains available fields; total outage retains stale cache', async () => {
  let clock = 0;
  let fail = false;
  const load = createFundamentalsLoader({ now: () => clock, fetchImpl: async (url) => {
    if (fail || url.endsWith('/annual')) throw new Error('offline');
    return { ok: true, json: async () => integration };
  } });
  const first = await load('005930.KS');
  assert.equal(first.per, 11.8);
  assert.equal(first.roe, null);
  assert.equal(first.forwardPer, 5.79);
  fail = true;
  clock = 300_001;
  const stale = await load('005930.KS');
  assert.equal(stale.per, first.per);
  assert.equal(stale.stale, true);
});

test('invalid symbols and indices do not contact a data provider', async () => {
  const load = createFundamentalsLoader({ fetchImpl: () => { throw new Error('should not call'); } });
  await assert.rejects(load('../secret'), /invalid symbol/);
  assert.deepEqual(await load('^KS11'), { symbol: '^KS11', source: null });
});
