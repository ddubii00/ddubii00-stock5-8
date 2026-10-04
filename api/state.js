import { authorized, loadState, saveState } from './_state.js';

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'invalid password' });
  try {
    if (req.method === 'GET') return res.json(await loadState(req));
    if (req.method === 'PUT') return res.json(await saveState(req.body, req));
    return res.status(405).json({ error: 'method not allowed' });
  } catch (error) { return res.status(500).json({ error: error.message }); }
}
