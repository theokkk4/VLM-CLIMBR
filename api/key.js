// POST /api/key — on Vercel the key is an environment variable, not a file.
// Tests the pasted key anyway, so the person knows whether it is good.
import { checkKey } from '../server/core.mjs'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const check = await checkKey(String(req.body?.key ?? '').trim())
  res.status(400).json({ ...check, ok: false, saved: false, error: check.ok ? 'The key works. On Vercel, add it as VLMRUN_API_KEY under Settings → Environment Variables and redeploy.' : check.error })
}
