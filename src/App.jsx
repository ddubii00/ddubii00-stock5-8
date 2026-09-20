import { useCallback, useEffect, useState } from 'react';
import ChartColumn from './components/ChartColumn';
import StockSearch from './components/StockSearch';
import { apiUrl } from './api';
import './index.css';

const GROUPS = ['1. 롱 보유', '2. 숏 보유', '3. 롱 관심', '4. 숏 관심'];
const DEFAULT_STATE = { mode: 'KRX', items: [] };
const signed = (v, suffix = '') => Number.isFinite(Number(v)) ? `${Number(v) > 0 ? '+' : ''}${Number(v).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}${suffix}` : '-';
const MARKET_TILES = [
  { key: 'kospi', label: 'KOSPI', symbol: '^KS11' }, { key: 'kosdaq', label: 'KOSDAQ', symbol: '^KQ11' },
  { key: 'usdKrw', label: '환율', symbol: 'KRW=X' }, { key: 'nasdaq', label: '나스닥', symbol: '^IXIC' },
];

function MarketTicker({ label, quote }) {
  const tone = Number(quote?.change) > 0 ? 'up' : Number(quote?.change) < 0 ? 'down' : '';
  return <span className={`market-item ${tone}`}><span>{label}</span><strong className="market-price">{quote ? signed(quote.price) : '-'}</strong><span className="market-change">{quote && Number.isFinite(Number(quote.changePct)) ? `(${signed(quote.changePct, '%')})` : ''}</span></span>;
}

function Login({ onLogin }) {
  const [password, setPassword] = useState(''); const [error, setError] = useState('');
  const submit = async e => { e.preventDefault(); setError(''); const r = await fetch(apiUrl('/state'), { headers: { 'x-stock5-password': password } }); if (!r.ok) return setError('비밀번호를 확인해 주세요.'); localStorage.setItem('stock5-8-password', password); onLogin(password, await r.json()); };
  return <main className="login-page"><form className="login-card" onSubmit={submit}><h1>stock5-8</h1><p>관심종목과 메모는 모든 기기에서 공유됩니다.</p><input autoFocus type="password" inputMode="numeric" placeholder="비밀번호" value={password} onChange={e => setPassword(e.target.value)} /><button>입장</button>{error && <small>{error}</small>}</form></main>;
}

function WatchlistModal({ state, onChange, onClose }) {
  const [group, setGroup] = useState(GROUPS[0]); const [quotes, setQuotes] = useState({});
  const add = stock => { if (!state.items.some(item => item.symbol === stock.symbol)) onChange({ ...state, items: [...state.items, { ...stock, id: crypto.randomUUID(), group, memo: '', memoPosition: { x: 12, y: 58 }, memoSize: { width: 145, height: 78 } }] }); };
  useEffect(() => { state.items.forEach(item => fetch(apiUrl(`/quote?symbol=${encodeURIComponent(item.symbol)}`)).then(r => r.ok ? r.json() : null).then(q => q && setQuotes(old => ({ ...old, [item.symbol]: q })))); }, [state.items]);
  const reorder = (e, targetId) => { e.preventDefault(); const id = e.dataTransfer.getData('stock-id'); if (!id || id === targetId) return; const next = [...state.items]; const from = next.findIndex(x => x.id === id); const to = next.findIndex(x => x.id === targetId); next.splice(to, 0, next.splice(from, 1)[0]); onChange({ ...state, items: next }); };
  return <div className="modal-backdrop"><section className="watchlist-modal"><header><div><h2>종목</h2><p>카테고리별 순서가 차트 순서입니다.</p></div><button className="close-button" onClick={onClose}>닫기</button></header><div className="category-tabs">{GROUPS.map(name => <button className={group === name ? 'active' : ''} key={name} onClick={() => setGroup(name)}>{name}</button>)}</div><StockSearch onSelect={add} placeholder="한국·미국·일본 종목 또는 지수 검색 (예: 삼전, AAPL, Nikkei)" />{GROUPS.map(name => <div className="watch-group" key={name}><h3>{name}</h3>{state.items.filter(item => item.group === name).map(item => { const q = quotes[item.symbol]; return <div className="watch-row" key={item.id} draggable onDragStart={e => e.dataTransfer.setData('stock-id', item.id)} onDragOver={e => e.preventDefault()} onDrop={e => reorder(e, item.id)}><span className="drag-handle">⠿</span><div><b>{item.name}</b><small>{item.symbol}</small></div><div className={`watch-quote ${(q?.change || 0) >= 0 ? 'up' : 'down'}`}>{q ? <><b>{signed(q.price)}</b><small>{signed(q.change)} ({signed(q.changePct, '%')})</small></> : <small>시세 불러오는 중</small>}</div><button className="remove-button" title={`${item.name} 삭제`} onClick={() => onChange({ ...state, items: state.items.filter(row => row.id !== item.id) })}>×</button></div>; })}</div>)}</section></div>;
}

export default function App() {
  const [password, setPassword] = useState(''); const [state, setState] = useState(null); const [modal, setModal] = useState(false); const [marketSummary, setMarketSummary] = useState({});
  const clearAuthentication = useCallback(() => { localStorage.removeItem('stock5-8-password'); setPassword(''); setState(null); }, []);
  const save = useCallback(async next => { setState(next); const response = await fetch(apiUrl('/state'), { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-stock5-password': password }, body: JSON.stringify(next) }); if (response.status === 401) clearAuthentication(); else if (!response.ok) throw new Error('공유 저장에 실패했습니다.'); }, [password, clearAuthentication]);
  const login = (pw, initial) => { setPassword(pw); setState({ ...DEFAULT_STATE, ...initial, items: initial.items || [] }); };
  useEffect(() => { const pw = localStorage.getItem('stock5-8-password'); if (pw) fetch(apiUrl('/state'), { headers: { 'x-stock5-password': pw } }).then(r => r.ok ? r.json() : Promise.reject()).then(data => login(pw, data)).catch(clearAuthentication); }, [clearAuthentication]);
  const refreshMarketSummary = useCallback(() => Promise.allSettled(MARKET_TILES.map(async ({ key, symbol }) => {
    const response = await fetch(apiUrl(`/quote?symbol=${encodeURIComponent(symbol)}`));
    return [key, response.ok ? await response.json() : null];
  })).then(entries => setMarketSummary(current => ({ ...current, ...Object.fromEntries(entries.filter(entry => entry.status === 'fulfilled').map(entry => entry.value).filter(([, quote]) => quote)) }))).catch(() => {}), []);
  useEffect(() => { if (!state) return undefined; refreshMarketSummary(); const timer = setInterval(refreshMarketSummary, 10_000); return () => clearInterval(timer); }, [state, refreshMarketSummary]);
  if (!state) return <Login onLogin={login} />;
  const ordered = GROUPS.flatMap(group => state.items.filter(item => item.group === group));
  return <div className="app"><header className="app-header"><strong className="app-title">stock5-8</strong><div className="market-summary" aria-label="시장 실시간 시세">{MARKET_TILES.map(tile => <MarketTicker key={tile.key} label={tile.label} quote={marketSummary[tile.key]} />)}</div><div className="header-actions"><button className={state.mode === 'KRX' ? 'active' : ''} onClick={() => save({ ...state, mode: 'KRX' })}>KRX</button><button className={state.mode === 'KRX2' ? 'active' : ''} onClick={() => save({ ...state, mode: 'KRX2' })}>KRX 장후</button><button onClick={() => setModal(true)}>종목</button></div></header>{ordered.length ? <div className="dashboard-grid watch-dashboard">{ordered.map(item => <div className="watch-chart" key={item.id}><div className={`watch-category ${item.group.includes('숏') ? 'short' : 'long'}`}>{item.group}</div><ChartColumn id={`watch-${item.id}`} defaultSymbol={item.symbol} defaultName={item.name} marketMode={state.mode} memo={item.memo} memoPosition={item.memoPosition} memoSize={item.memoSize} onMemoChange={(memo, memoPosition, memoSize) => save({ ...state, items: state.items.map(row => row.id === item.id ? { ...row, memo, memoPosition, memoSize } : row) })} /></div>)}</div> : <main className="empty-state"><h2>관심 종목을 추가하세요</h2><p>상단의 ‘종목’ 버튼에서 카테고리를 고르고 종목·지수를 검색할 수 있습니다.</p><button onClick={() => setModal(true)}>종목 추가</button></main>}{modal && <WatchlistModal state={state} onChange={save} onClose={() => setModal(false)} />}</div>;
}
