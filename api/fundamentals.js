import { yahooFinance } from './_shared.js';
import { createFundamentalsLoader } from './_fundamentals.js';

const loadFundamentals = createFundamentalsLoader({ yahooFinance });

export default async function handler(req, res) {
  if (!req.query.symbol) return res.status(400).json({ error: 'symbol required' });
  try {
    return res.json(await loadFundamentals(req.query.symbol));
  } catch {
    return res.status(400).json({ error: 'invalid symbol' });
  }
}
