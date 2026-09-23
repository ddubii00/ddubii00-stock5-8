import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl } from '../api';

const normalize = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, '');

function matchesQuery(item, query) {
  const q = normalize(query);
  if (!q) return true;
  return normalize(item?.name).includes(q)
    || normalize(item?.symbol).includes(q)
    || normalize(item?.exchange).includes(q);
}

function StockSearch({ onSelect, placeholder }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const wrapperRef = useRef(null);
  const timerRef = useRef(null);
  const requestSeqRef = useRef(0);
  const queryRef = useRef('');
  const cacheRef = useRef(new Map());
  const itemRefs = useRef([]);

  useEffect(() => {
    const handler = (event) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setOpen(false);
        setActiveIndex(-1);
      }
    };

    document.addEventListener('mousedown', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      clearTimeout(timerRef.current);
      requestSeqRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (activeIndex < 0) return;
    itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const applyResults = useCallback((items) => {
    const next = Array.isArray(items) ? items : [];
    setResults(next);
    setOpen(next.length > 0);
    setActiveIndex(-1);
  }, []);

  // Keep the fetch implementation separate so old responses cannot overwrite
  // a newer search. This also avoids repeatedly rebuilding the callback above.
  const runSearch = useCallback(async (rawQuery) => {
    const trimmed = String(rawQuery || '').trim();
    const key = normalize(trimmed);

    if (!key) {
      setResults([]);
      setOpen(false);
      setActiveIndex(-1);
      setLoading(false);
      return;
    }

    const exactCached = cacheRef.current.get(key);
    if (exactCached) {
      applyResults(exactCached);
      setLoading(false);
      return;
    }

    const cachedPrefix = [...cacheRef.current.keys()]
      .filter((cachedKey) => key.startsWith(cachedKey))
      .sort((a, b) => b.length - a.length)[0];

    if (cachedPrefix) {
      const provisional = (cacheRef.current.get(cachedPrefix) || []).filter((item) => matchesQuery(item, key));
      if (provisional.length) {
        setResults(provisional);
        setOpen(true);
        setActiveIndex(-1);
      }
    }

    const seq = ++requestSeqRef.current;
    setLoading(true);

    try {
      const res = await fetch(apiUrl(`/search?q=${encodeURIComponent(trimmed)}`), {
        cache: 'no-store',
        priority: 'high',
      });
      const contentType = res.headers.get('content-type') || '';

      if (!res.ok) {
        const body = contentType.includes('application/json')
          ? await res.json().catch(() => null)
          : await res.text();
        throw new Error(body?.error || body || `검색 실패 (${res.status})`);
      }

      if (!contentType.includes('application/json')) {
        throw new Error('서버가 JSON 대신 다른 응답을 반환했습니다.');
      }

      const payload = await res.json();
      const data = Array.isArray(payload) ? payload : [];
      cacheRef.current.set(key, data);

      if (seq === requestSeqRef.current && normalize(queryRef.current) === key) {
        applyResults(data);
      }
    } catch {
      if (seq === requestSeqRef.current && normalize(queryRef.current) === key) {
        setResults([]);
        setOpen(false);
        setActiveIndex(-1);
      }
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [applyResults]);

  const handleChange = (event) => {
    const value = event.target.value;
    const key = normalize(value);

    queryRef.current = value;
    setQuery(value);
    setActiveIndex(-1);
    clearTimeout(timerRef.current);

    if (!key) {
      requestSeqRef.current += 1;
      setResults([]);
      setOpen(false);
      setLoading(false);
      return;
    }

    const cached = cacheRef.current.get(key);
    if (cached) {
      applyResults(cached);
      setLoading(false);
      return;
    }

    // 400 ms -> 90 ms. The expensive watchlist quote traffic is now low
    // priority, so the search request can take a browser connection first.
    timerRef.current = setTimeout(() => {
      void runSearch(value);
    }, 90);
  };

  const handleSelect = (item) => {
    if (!item) return;
    clearTimeout(timerRef.current);
    requestSeqRef.current += 1;
    const selectedText = item.name + (item.symbol ? ` (${item.symbol})` : '');
    queryRef.current = selectedText;
    setQuery(selectedText);
    setOpen(false);
    setActiveIndex(-1);
    setLoading(false);
    onSelect({ symbol: item.symbol, name: item.name });
  };

  const handleKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      if (!results.length) return;
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => current < results.length - 1 ? current + 1 : 0);
      return;
    }

    if (event.key === 'ArrowUp') {
      if (!results.length) return;
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => current > 0 ? current - 1 : results.length - 1);
      return;
    }

    if (event.key === 'Enter' && results.length > 0) {
      event.preventDefault();
      handleSelect(results[activeIndex >= 0 ? activeIndex : 0]);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div className="search-wrapper" ref={wrapperRef}>
      <input
        type="text"
        className="search-input"
        placeholder={placeholder || '종목 검색...'}
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (results.length > 0) setOpen(true); }}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open && results.length > 0}
        aria-controls="stock-search-results"
        aria-activedescendant={activeIndex >= 0 ? `stock-search-result-${activeIndex}` : undefined}
      />

      {loading && <span className="search-spinner">⟳</span>}

      {open && results.length > 0 && (
        <div className="search-dropdown" id="stock-search-results" role="listbox">
          {results.map((item, index) => {
            const active = index === activeIndex;
            return (
              <div
                key={`${item.symbol}-${index}`}
                id={`stock-search-result-${index}`}
                ref={(element) => { itemRefs.current[index] = element; }}
                className={`search-item${active ? ' active' : ''}`}
                role="option"
                aria-selected={active}
                style={active ? { background: '#e8f0fe' } : undefined}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  handleSelect(item);
                }}
              >
                <span className="search-item-name">{item.name}</span>
                <span className="search-item-meta">
                  {item.symbol} &middot; {item.exchange}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default memo(StockSearch);
