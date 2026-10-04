import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { logicalAtTime, timeAtLogical } from '../utils/trendLines';

function TrendLineShape({ line, drawing, selected, onSelect, onEndpoint }) {
  return (
    <g>
      <line x1={line.a.x} y1={line.a.y} x2={line.b.x} y2={line.b.y} stroke="#000" strokeWidth={line.width || 1} pointerEvents="none" />
      {!drawing && <line x1={line.a.x} y1={line.a.y} x2={line.b.x} y2={line.b.y} stroke="transparent" strokeWidth="12"
        style={{ pointerEvents: 'stroke', cursor: 'pointer' }} onPointerDown={(event) => onSelect(event, line)} />}
      {selected && !drawing && ['start', 'end'].map((endpoint) => {
        const point = endpoint === 'start' ? line.a : line.b;
        return <circle key={endpoint} cx={point.x} cy={point.y} r="5" fill="#fff" stroke="#000" strokeWidth="1.5"
          style={{ pointerEvents: 'all', cursor: 'move' }} onPointerDown={(event) => onEndpoint(event, line, endpoint)} />;
      })}
      <title>{`${new Date(line.start.time * 1000).toLocaleString('ko-KR')} · ${line.start.price.toLocaleString('ko-KR')} → ${new Date(line.end.time * 1000).toLocaleString('ko-KR')} · ${line.end.price.toLocaleString('ko-KR')}`}</title>
    </g>
  );
}

export default function TrendLineOverlay({ chartsRef, seriesRef, candlesRef, containerRef, ready, lines = [], onChange }) {
  const [drawing, setDrawing] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [geometry, setGeometry] = useState({ width: 0, height: 0, points: [] });
  const dragRef = useRef(null);
  const rootRef = useRef(null);
  const clipId = useId();
  const repaint = useCallback(() => {
    const chart = chartsRef.current.price;
    const series = seriesRef.current.candle;
    if (!chart || !series) return;
    const scale = chart.timeScale();
    const visibleLines = draft
      ? [...lines.filter((line) => line.id !== draft.id), draft]
      : lines;
    const point = (anchor) => {
      const logical = logicalAtTime(candlesRef.current, anchor.time);
      return {
        x: logical == null ? null : scale.logicalToCoordinate(logical),
        y: series.priceToCoordinate(anchor.price),
      };
    };
    const next = {
      width: scale.width(),
      height: chart.panes()[0]?.getHeight() || 0,
      points: visibleLines.map((line) => ({ ...line, a: point(line.start), b: point(line.end) })),
    };
    setGeometry((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
  }, [chartsRef, seriesRef, candlesRef, lines, draft]);

  useEffect(() => {
    if (!ready) return undefined;
    const chart = chartsRef.current.price;
    const container = containerRef.current;
    if (!chart || !container) return undefined;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(repaint);
    };
    schedule();
    chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
    container.addEventListener('trend-data', schedule);
    // Price-scale dragging also changes endpoint coordinates.
    rootRef.current?.parentElement.addEventListener('pointermove', schedule);
    const parent = rootRef.current?.parentElement;
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    return () => {
      cancelAnimationFrame(frame);
      try { chart.timeScale().unsubscribeVisibleLogicalRangeChange(schedule); } catch { /* Chart may already be removed. */ }
      container.removeEventListener('trend-data', schedule);
      parent?.removeEventListener('pointermove', schedule);
      observer.disconnect();
    };
  }, [ready, chartsRef, containerRef, repaint]);

  const anchorAt = (event) => {
    const chart = chartsRef.current.price;
    const series = seriesRef.current.candle;
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!chart || !series || !bounds) return null;
    const x = Math.max(0, Math.min(geometry.width, event.clientX - bounds.left));
    const y = Math.max(0, Math.min(geometry.height, event.clientY - bounds.top));
    const time = timeAtLogical(candlesRef.current, chart.timeScale().coordinateToLogical(x));
    const price = series.coordinateToPrice(y);
    return time != null && Number.isFinite(price) ? { time, price } : null;
  };

  const beginDrag = (event, line, endpoint) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    rootRef.current.focus({ preventScroll: true });
    const cleanLine = { id: line.id, start: line.start, end: line.end, width: line.width };
    setSelectedId(line.id);
    setDraft(cleanLine);
    dragRef.current = { line: cleanLine, endpoint, created: !endpoint, x: event.clientX, y: event.clientY };
    event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
  };

  const move = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    const anchor = anchorAt(event);
    if (!anchor) return;
    event.preventDefault();
    setDraft({ ...drag.line, [drag.endpoint || 'end']: anchor });
  };

  const finish = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    const anchor = anchorAt(event);
    const moved = Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 3;
    if (anchor && (!drag.created || moved)) {
      const next = { ...drag.line, [drag.endpoint || 'end']: anchor };
      onChange([...lines.filter((line) => line.id !== next.id), next]);
    }
    dragRef.current = null;
    setDraft(null);
    if (drag.created) setDrawing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const cancel = () => {
    dragRef.current = null;
    setDraft(null);
    setDrawing(false);
  };

  const selectLine = (event, line) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(line.id);
    rootRef.current.focus({ preventScroll: true });
  };

  return (
    <div className="trend-line-editor" ref={rootRef} tabIndex={-1}
      onKeyDown={(event) => {
        if (event.target.closest('input, textarea, select')) return;
        if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
          event.preventDefault();
          onChange(lines.filter((line) => line.id !== selectedId));
          setSelectedId(null);
          cancel();
        } else if (event.key === 'Escape') {
          cancel();
          setSelectedId(null);
        }
      }}>
      <div className="trend-line-toolbar">
        <button type="button" className={drawing ? 'active' : ''} aria-pressed={drawing}
          title="누른 뒤 차트에서 시작점부터 끝점까지 드래그" disabled={!ready}
          onClick={() => { setDrawing((value) => !value); setSelectedId(null); }}>선</button>
        <button type="button" disabled={!lines.length} onClick={() => { onChange([]); setSelectedId(null); cancel(); }}>선 삭제</button>
        <button type="button" disabled={!lines.some((line) => line.id === selectedId)} title="선택한 선 굵기 1 → 2 → 3"
          onClick={() => onChange(lines.map((line) => line.id === selectedId ? { ...line, width: (line.width || 1) % 3 + 1 } : line))}>
          굵기{selectedId ? ` ${lines.find((line) => line.id === selectedId)?.width || 1}` : ''}
        </button>
      </div>
      <svg className={`trend-line-overlay${drawing ? ' drawing' : ''}`} width={geometry.width} height={geometry.height}
        onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel}>
        <defs><clipPath id={clipId}><rect width={geometry.width} height={geometry.height} /></clipPath></defs>
        <g clipPath={`url(#${clipId})`}>
          <rect width={geometry.width} height={geometry.height} fill="transparent" style={{ pointerEvents: drawing ? 'all' : 'none' }}
            onPointerDown={(event) => {
              const anchor = anchorAt(event);
              if (anchor) beginDrag(event, { id: crypto.randomUUID(), start: anchor, end: anchor, width: 1 });
            }} />
          {geometry.points.filter((line) => [line.a.x, line.a.y, line.b.x, line.b.y].every(Number.isFinite)).map((line) => (
            <TrendLineShape key={line.id} line={line} drawing={drawing} selected={line.id === selectedId}
              onSelect={selectLine} onEndpoint={beginDrag} />
          ))}
        </g>
      </svg>
    </div>
  );
}
