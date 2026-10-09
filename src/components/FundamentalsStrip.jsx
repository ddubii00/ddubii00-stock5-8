import { useEffect, useState } from 'react';
import { apiUrl } from '../api';
import { formatFundamentalAmount, formatRatio } from '../utils/fundamentalFormat';

export default function FundamentalsStrip({ symbol }) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!symbol || symbol.startsWith('^') || symbol.includes('=')) return undefined;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(apiUrl(`/fundamentals?symbol=${encodeURIComponent(symbol)}`), {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        });
        if (!response.ok) throw new Error('재무정보 없음');
        const data = await response.json();
        if (!controller.signal.aborted) setResult({ ...data, symbol });
      } catch {
        if (!controller.signal.aborted) setResult(current => current?.symbol === symbol && current.source
          ? { ...current, stale: true } : { symbol, unavailable: true });
      }
    };
    void load();
    const timer = setInterval(load, 60 * 60 * 1000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [symbol]);

  if (!symbol || symbol.startsWith('^') || symbol.includes('=')) return null;
  const data = result?.symbol === symbol ? result : {};
  const annual = data.fiscalPeriod === '최근 12개월' ? '최근 12개월 실적' : `최근 연간 실적${data.fiscalPeriod ? ` (${data.fiscalPeriod})` : ''}`;
  const forecast = `연간 예상치${data.forecastPeriod ? ` (${data.forecastPeriod})` : ''}`;
  const items = [
    ['PER', formatRatio(data.per), `최근 실적 기준${data.valuationPeriod ? ` (${data.valuationPeriod})` : ''}`],
    ['F.PER', formatRatio(data.forwardPer), forecast],
    ['ROE', formatRatio(data.roe, '%'), data.source === 'yahoo' ? '최근 12개월 ROE' : annual],
    ['F.ROE', formatRatio(data.forwardRoe, '%'), forecast],
    ['PBR', formatRatio(data.pbr), '주가순자산비율'],
    ['PEG*', formatRatio(data.peg), data.pegBasis || '예상 EPS 증가율 기반 추정 PEG (미제공 시 —)'],
    ['시총', formatFundamentalAmount(data.marketCap, data.currency), '데이터 제공처 시가총액'],
    ['매출', formatFundamentalAmount(data.revenue, data.financialCurrency), annual],
    ['영업이익', formatFundamentalAmount(data.operatingIncome, data.financialCurrency), annual],
  ];
  const status = data.unavailable ? ' · 재무정보 미제공' : data.stale ? ' · 이전 데이터 (제공처 응답 지연)' : '';
  return <div className="fundamentals-strip" aria-label="종목 재무정보" title={`출처: ${data.source === 'naver' ? '네이버 증권' : data.source === 'yahoo' ? 'Yahoo Finance' : '조회 중'}${status}`}>
    {items.map(([label, value, title]) => <span className="fundamental-item" key={label} title={title}>
      <span>{label}</span><b>{value}</b>
    </span>)}
  </div>;
}
