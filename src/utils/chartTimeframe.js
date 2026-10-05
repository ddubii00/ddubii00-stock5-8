import { useState } from 'react';

export function applyGlobalWeekly(state, enabled, weeklyTf) {
  if (state.globalWeekly === enabled) return state;
  return {
    globalWeekly: enabled,
    tf: enabled ? weeklyTf : state.restoreTf,
    restoreTf: enabled ? state.tf : state.restoreTf,
  };
}

export function selectTimeframe(state, tf) {
  return { ...state, tf, restoreTf: state.globalWeekly ? tf : state.restoreTf };
}

// A global toggle is a command, not a lock: local selections keep working.
export function useChartTimeframe(defaultTf, weeklyTf, globalWeekly) {
  const [state, setState] = useState(() => ({
    globalWeekly,
    tf: globalWeekly ? weeklyTf : defaultTf,
    restoreTf: defaultTf,
  }));
  const current = applyGlobalWeekly(state, globalWeekly, weeklyTf);
  if (current !== state) setState(current);
  return [current.tf, (tf) => setState(previous => selectTimeframe(previous, tf))];
}
