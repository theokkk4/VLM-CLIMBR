// POST /api/analyze {url, color, name} — the Vercel side of live analysis.
// The clip is already in Vercel Blob (see api/upload.js): fetch it to /tmp, run
// the shared analysis, stream NDJSON progress. The playback copy and poster go
// back to Blob for the browser; the uploaded original is deleted.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { del, put } from '@vercel/blob'
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

const TYPES = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg' }

async function publish(id, files) {
  const out = {}
  for (const [key, file] of Object.entries(files)) {
    const ext = path.extname(file)
    const blob = await put(`media/${id}/${path.basename(file)}`, fs.readFileSync(file), { access: 'public', contentType: TYPES[ext] ?? 'application/octet-stream', addRandomSuffix: true })
    out[key] = blob.url
  }
  return out
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')
  const send = (obj) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n') }
  const ctrl = new AbortController()
  res.on('close', () => { if (!res.writableFinished) ctrl.abort() })
  const { url, color, name } = req.body ?? {}
  const file = path.join(WORK, `${randomUUID()}${path.extname(new URL(url ?? 'x:/a').pathname) || '.mp4'}`)
  try {
    if (!url || !allowed(url)) throw Object.assign(httpError(400, 'Expected the URL of a clip in this project’s Vercel Blob store.'), { stage: 'uploading' })
    const r = await fetch(url)
    if (!r.ok) throw Object.assign(httpError(502, `Could not read the uploaded clip from Blob (${r.status}).`), { stage: 'uploading' })
    fs.mkdirSync(WORK, { recursive: true })
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()))
    send({ type: 'stage', stage: 'uploading', status: 'done', detail: `${(fs.statSync(file).size / 1e6).toFixed(1)} MB in Vercel Blob` })
    send(await analyzeFile(file, { color, name: name || path.basename(new URL(url).pathname), publish, signal: ctrl.signal }, send))
  } catch (err) {
    send({ type: 'error', stage: err.stage ?? null, message: err.message ?? String(err), status: err.status ?? 500 })
  } finally {
    fs.rmSync(file, { force: true })
    if (url && allowed(url) && process.env.BLOB_READ_WRITE_TOKEN) await del(url).catch(() => {})
    res.end()
  }
}
