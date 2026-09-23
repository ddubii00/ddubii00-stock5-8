import { useCallback, useEffect, useRef, useState } from 'react';
import ChartColumn from './components/ChartColumn';
import StockSearch from './components/StockSearch';
import { apiUrl } from './api';
import './index.css';

const GROUPS = ['1. 롱 보유', '2. 숏 보유', '3. 롱 관심', '4. 숏 관심'];
const DEFAULT_STATE = { mode: 'KRX', items: [] };
const APP_ID = typeof window !== 'undefined'
  ? (window.location.pathname.match(/\/(stock5-\d+)(?:\/|$)/)?.[1] || 'stock5-8')
  : 'stock5-8';
const PASSWORD_STORAGE_KEY = `${APP_ID}-password`;

const signed = (v, suffix = '') => Number.isFinite(Number(v))
  ? `${Number(v) > 0 ? '+' : ''}${Number(v).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}${suffix}`
  : '-';

const MARKET_TILES = [
  { key: 'kospi', label: 'KOSPI', symbol: '^KS11' },
  { key: 'kosdaq', label: 'KOSDAQ', symbol: '^KQ11' },
  { key: 'usdKrw', label: '환율', symbol: 'KRW=X' },
  { key: 'nasdaq', label: '나스닥', symbol: '^IXIC' },
  { key: 'sp500', label: 'S&P500', symbol: '^GSPC' },
];

function MarketTicker({ label, quote }) {
  const tone = Number(quote?.change) > 0 ? 'up' : Number(quote?.change) < 0 ? 'down' : '';
  return (
    <span className={`market-item ${tone}`}>
      <span>{label}</span>
      <strong className="market-price">{quote ? signed(quote.price) : '-'}</strong>
      <span className="market-change">
        {quote && Number.isFinite(Number(quote.changePct)) ? `(${signed(quote.changePct, '%')})` : ''}
      </span>
    </span>
  );
}

function Login({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setError('');

    const response = await fetch(apiUrl('/state'), {
      headers: { 'x-stock5-password': password },
    });

    if (!response.ok) {
      setError('비밀번호를 확인해 주세요.');
      return;
    }

    localStorage.setItem(PASSWORD_STORAGE_KEY, password);
    onLogin(password, await response.json());
  };

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit}>
        <h1>{APP_ID}</h1>
        <p>관심종목과 메모는 모든 기기에서 공유됩니다.</p>
        <input
          autoFocus
          type="password"
          inputMode="numeric"
          placeholder="비밀번호"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button>입장</button>
        {error && <small>{error}</small>}
      </form>
    </main>
  );
}

function WatchlistModal({ state, onChange, onClose }) {
  const [group, setGroup] = useState(GROUPS[0]);
  const [quotes, setQuotes] = useState({});
  const quoteStatusRef = useRef(new Map());
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const add = useCallback((stock) => {
    if (state.items.some((item) => item.symbol === stock.symbol)) return;

    onChange({
      ...state,
      items: [
        ...state.items,
        {
          ...stock,
          id: crypto.randomUUID(),
          group,
          memo: '',
          memoPosition: { x: 12, y: 58 },
          memoSize: { width: 145, height: 78 },
        },
      ],
    });
  }, [group, onChange, state]);

  // Important performance change:
  // Previously, every watchlist change launched one quote request for EVERY
  // saved stock at once. With a large watchlist that could occupy all browser
  // connections and make /api/search wait behind dozens of quote requests.
  //
  // Now each symbol is requested only once per modal session, with at most
  // two low-priority quote requests at a time. Search requests stay responsive.
  useEffect(() => {
    const missing = state.items.filter((item) => {
      const status = quoteStatusRef.current.get(item.symbol);
      return status !== 'pending' && status !== 'done';
    });

    if (!missing.length) return;

    missing.forEach((item) => quoteStatusRef.current.set(item.symbol, 'pending'));

    void (async () => {
      const updates = {};
      let cursor = 0;

      const worker = async () => {
        while (cursor < missing.length) {
          const item = missing[cursor++];
          try {
            const response = await fetch(apiUrl(`/quote?symbol=${encodeURIComponent(item.symbol)}`), {
              cache: 'no-store',
              priority: 'low',
            });

            if (!response.ok) throw new Error('quote unavailable');
            const quote = await response.json();
            updates[item.symbol] = quote;
            quoteStatusRef.current.set(item.symbol, 'done');
          } catch {
            quoteStatusRef.current.delete(item.symbol);
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(2, missing.length) }, () => worker()),
      );

      if (mountedRef.current && Object.keys(updates).length) {
        setQuotes((current) => ({ ...current, ...updates }));
      }
    })();
  }, [state.items]);

  const reorder = (event, targetId) => {
    event.preventDefault();
    const id = event.dataTransfer.getData('stock-id');
    if (!id || id === targetId) return;

    const next = [...state.items];
    const from = next.findIndex((item) => item.id === id);
    const to = next.findIndex((item) => item.id === targetId);
    next.splice(to, 0, next.splice(from, 1)[0]);
    onChange({ ...state, items: next });
  };

  return (
    <div className="modal-backdrop">
      <section className="watchlist-modal">
        <header>
          <div>
            <h2>종목</h2>
            <p>카테고리별 순서가 차트 순서입니다.</p>
          </div>
          <button className="close-button" onClick={onClose}>닫기</button>
        </header>

        <div className="category-tabs">
          {GROUPS.map((name) => (
            <button
              className={group === name ? 'active' : ''}
              key={name}
              onClick={() => setGroup(name)}
            >
              {name}
            </button>
          ))}
        </div>

        <StockSearch
          onSelect={add}
          placeholder="한국·미국·일본 종목 또는 지수 검색 (예: 삼성, 삼전, AAPL, Nikkei)"
        />

        {GROUPS.map((name) => (
          <div className="watch-group" key={name}>
            <h3>{name}</h3>
            {state.items.filter((item) => item.group === name).map((item) => {
              const quote = quotes[item.symbol];
              return (
                <div
                  className="watch-row"
                  key={item.id}
                  draggable
                  onDragStart={(event) => event.dataTransfer.setData('stock-id', item.id)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => reorder(event, item.id)}
                >
                  <span className="drag-handle">⠿</span>
                  <div>
                    <b>{item.name}</b>
                    <small>{item.symbol}</small>
                  </div>
                  <div className={`watch-quote ${(quote?.change || 0) >= 0 ? 'up' : 'down'}`}>
                    {quote
                      ? <>
                          <b>{signed(quote.price)}</b>
                          <small>{signed(quote.change)} ({signed(quote.changePct, '%')})</small>
                        </>
                      : <small>시세 불러오는 중</small>}
                  </div>
                  <button
                    className="remove-button"
                    title={`${item.name} 삭제`}
                    onClick={() => onChange({
                      ...state,
                      items: state.items.filter((row) => row.id !== item.id),
                    })}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </section>
    </div>
  );
}

export default function App() {
  const [password, setPassword] = useState('');
  const [state, setState] = useState(null);
  const [modal, setModal] = useState(false);
  const [marketSummary, setMarketSummary] = useState({});
  const [showBollinger, setShowBollinger] = useState(true);

  const clearAuthentication = useCallback(() => {
    localStorage.removeItem(PASSWORD_STORAGE_KEY);
    setPassword('');
    setState(null);
  }, []);

  const save = useCallback(async (next) => {
    setState(next);

    const response = await fetch(apiUrl('/state'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-stock5-password': password,
      },
      body: JSON.stringify(next),
    });

    if (response.status === 401) clearAuthentication();
    else if (!response.ok) throw new Error('공유 저장에 실패했습니다.');
  }, [password, clearAuthentication]);

  const login = (pw, initial) => {
    setPassword(pw);
    setState({
      ...DEFAULT_STATE,
      ...initial,
      items: initial.items || [],
    });
  };

  useEffect(() => {
    const pw = localStorage.getItem(PASSWORD_STORAGE_KEY);
    if (!pw) return;

    fetch(apiUrl('/state'), {
      headers: { 'x-stock5-password': pw },
    })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => login(pw, data))
      .catch(clearAuthentication);
  }, [clearAuthentication]);

  const refreshMarketSummary = useCallback(() => (
    Promise.allSettled(
      MARKET_TILES.map(async ({ key, symbol }) => {
        const response = await fetch(apiUrl(`/quote?symbol=${encodeURIComponent(symbol)}`));
        return [key, response.ok ? await response.json() : null];
      }),
    ).then((entries) => {
      setMarketSummary((current) => ({
        ...current,
        ...Object.fromEntries(
          entries
            .filter((entry) => entry.status === 'fulfilled')
            .map((entry) => entry.value)
            .filter(([, quote]) => quote),
        ),
      }));
    }).catch(() => {})
  ), []);

  useEffect(() => {
    if (!state) return undefined;

    refreshMarketSummary();
    const timer = setInterval(refreshMarketSummary, 10_000);
    return () => clearInterval(timer);
  }, [state, refreshMarketSummary]);

  if (!state) return <Login onLogin={login} />;

  const ordered = GROUPS.flatMap((group) => state.items.filter((item) => item.group === group));

  return (
    <div className="app">
      <header className="app-header">
        <strong className="app-title">{APP_ID}</strong>
        <div className="market-summary" aria-label="시장 실시간 시세">
          {MARKET_TILES.map((tile) => (
            <MarketTicker key={tile.key} label={tile.label} quote={marketSummary[tile.key]} />
          ))}
        </div>

        <div className="header-actions">
          <button
            className={state.mode === 'KRX' ? 'active' : ''}
            onClick={() => save({ ...state, mode: 'KRX' })}
          >
            KRX
          </button>
          <button
            className={showBollinger ? 'active' : ''}
            onClick={() => setShowBollinger((visible) => !visible)}
            title="전체 차트 볼린저밴드 표시"
          >
            BB
          </button>
          <button
            className={state.mode === 'KRX2' ? 'active' : ''}
            onClick={() => save({ ...state, mode: 'KRX2' })}
          >
            KRX 장후
          </button>
          <button onClick={() => setModal(true)}>종목</button>
        </div>
      </header>

      {ordered.length
        ? (
          <div className="dashboard-grid watch-dashboard">
            {ordered.map((item) => (
              <div className="watch-chart" key={item.id}>
                <div className={`watch-category ${item.group.includes('숏') ? 'short' : 'long'}`}>
                  {item.group}
                </div>
                <ChartColumn
                  id={`watch-${item.id}`}
                  defaultSymbol={item.symbol}
                  defaultName={item.name}
                  marketMode={state.mode}
                  showBollinger={showBollinger}
                  memo={item.memo}
                  memoPosition={item.memoPosition}
                  memoSize={item.memoSize}
                  onMemoChange={(memo, memoPosition, memoSize) => save({
                    ...state,
                    items: state.items.map((row) => (
                      row.id === item.id ? { ...row, memo, memoPosition, memoSize } : row
                    )),
                  })}
                />
              </div>
            ))}
          </div>
        )
        : (
          <main className="empty-state">
            <h2>관심 종목을 추가하세요</h2>
            <p>상단의 ‘종목’ 버튼에서 카테고리를 고르고 종목·지수를 검색할 수 있습니다.</p>
            <button onClick={() => setModal(true)}>종목 추가</button>
          </main>
        )}

      {modal && (
        <WatchlistModal
          state={state}
          onChange={save}
          onClose={() => setModal(false)}
        />
      )}
    </div>
  );
}
