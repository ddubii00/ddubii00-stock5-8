// Close-based three-line break. Time is the source bar that creates a line;
// the reversal opens at the previous body's edge, not its closing extreme.
// Rules: https://www.tradingview.com/support/solutions/43000502273-introduction-to-line-break-charts/
export function calculateThreeLineBreak(candles) {
  const lines = [];
  let seed = null;
  let volume = 0;
  let volumeKnown = true;
  let sourceCount = 0;
  let startTime = null;
  for (const candle of candles || []) {
    if (!Number.isFinite(candle?.close) || candle.time == null) continue;
    if (!sourceCount) startTime = candle.time;
    sourceCount++;
    if (typeof candle.volume === 'number' && Number.isFinite(candle.volume) && candle.volume >= 0) volume += candle.volume;
    else volumeKnown = false;
    if (seed == null) { seed = candle.close; continue; }
    const previous = lines.at(-1);
    let open;
    if (!previous) {
      if (candle.close === seed) continue;
      open = seed;
    } else {
      const recent = lines.slice(-3);
      const highest = Math.max(...recent.map(line => line.high));
      const lowest = Math.min(...recent.map(line => line.low));
      if (candle.close > highest) open = previous.high;
      else if (candle.close < lowest) open = previous.low;
      else continue; // Equal boundaries / inside-range prices produce no line.
    }
    lines.push({
      time: candle.time, open, close: candle.close,
      high: Math.max(open, candle.close), low: Math.min(open, candle.close),
      volume: volumeKnown ? volume : null, startTime, sourceCount,
    });
    volume = 0;
    volumeKnown = true;
    sourceCount = 0;
  }
  // Pending volume after the last breakout belongs to the next line, not the
  // last completed line. Do not invent a line simply to plot pending volume.
  return lines;
}
