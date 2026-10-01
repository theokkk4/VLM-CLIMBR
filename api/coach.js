// POST /api/coach {analytics, frames} — the browser sends its own keyframes.
import { coach } from '../server/core.mjs'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  try {
    const { analytics, frames } = req.body ?? {}
    res.status(200).json(await coach({ analytics, frames: Array.isArray(frames) ? frames : [] }))
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message ?? String(err) })
  }
}
