export function estimatedFundamentalLabel(label, value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${label}*` : label;
}

export function formatRatio(value, suffix = '') {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}${suffix}` : '—';
}

export function formatFundamentalAmount(value, currency) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const units = [[1e12, '조'], [1e8, '억'], [1e4, '만']];
  const [divisor, unit] = units.find(([size]) => Math.abs(value) >= size) || [1, ''];
  const amount = value / divisor;
  const digits = Math.abs(amount) >= 100 ? 0 : 1;
  const suffix = currency === 'KRW' ? '원' : currency === 'USD' ? '달러' : currency === 'JPY' ? '엔' : currency || '';
  return `${amount.toLocaleString('ko-KR', { maximumFractionDigits: digits })}${unit}${suffix}`;
}
