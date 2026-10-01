// POST /api/analyze {url, color, meta?} — the Vercel side of live analysis.
// The clip is already in Vercel Blob (see api/upload.js): fetch it to /tmp,
// run the shared analysis, stream NDJSON progress, then delete the blob.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { del } from '@vercel/blob'
import { WORK, analyzeFile, httpError } from '../server/core.mjs'

// Only fetch from this project's own Blob storage — never an arbitrary URL.
const allowed = (u) => {
  try {
    const { protocol, hostname } = new URL(u)
    if (process.env.CLIMBR_ALLOW_ANY_URL) return protocol === 'http:' || protocol === 'https:'
    return protocol === 'https:' && hostname.endsWith('.blob.vercel-storage.com')
  } catch {
    return false
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')
  const send = (obj) => res.write(JSON.stringify(obj) + '\n')
  const { url, color, meta, maxPoseFrames } = req.body ?? {}
  const file = path.join(WORK, `${randomUUID()}${path.extname(new URL(url ?? 'x:/a').pathname) || '.mp4'}`)
  try {
    if (!url || !allowed(url)) throw httpError(400, 'Expected the URL of a clip in this project’s Vercel Blob store.')
    const r = await fetch(url)
    if (!r.ok) throw httpError(502, `Could not read the uploaded clip (${r.status}).`)
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()))
    send({ type: 'stage', stage: 'upload', status: 'done', detail: `${(fs.statSync(file).size / 1e6).toFixed(1)} MB in Vercel Blob` })
    send(await analyzeFile(file, { color, meta, maxPoseFrames, keep: false }, send))
  } catch (err) {
    send({ type: 'error', message: err.message ?? String(err), status: err.status ?? 500 })
  } finally {
    fs.rmSync(file, { force: true })
    if (url && allowed(url) && process.env.BLOB_READ_WRITE_TOKEN) await del(url).catch(() => {})
    res.end()
  }
}
