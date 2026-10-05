export function anchoredMemoPosition(anchor, size, card, reference) {
  if (!['symbol-right', 'copy-right'].includes(anchor)) return null;
  const rightEdge = Math.max(0, card.width - size.width - 8);
  return {
    anchor,
    x: anchor === 'copy-right' && reference
      ? Math.min(rightEdge, Math.max(0, reference.right - card.left + 5))
      : rightEdge,
    y: reference ? Math.max(0, reference.top - card.top - 1) : 38,
  };
}
