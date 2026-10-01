// CLIMBR API for local runs and `npm start`: a thin Express wrapper around
// server/core.mjs. On Vercel the same core is served by api/*.js instead.
//
// The browser never sees the API key. It uploads a clip here; the core
// transcodes it, asks SAM 3.1 to track the route's holds and ViTPose+ to track
// the climber, and progress streams back as NDJSON. The route itself is read
// in the browser (src/lib/analyze.ts), so a live run and a pasted gateway
// payload go through the same code.

import express from 'express'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import { API_KEY, BASE_URL, MEDIA, ROOT, WORK, analyzeFile, coach, hasFfmpeg, health, httpError, sampleFrames } from './core.mjs'

const UPLOADS = path.join(WORK, 'uploads')
fs.mkdirSync(UPLOADS, { recursive: true })
const PROD = process.argv.includes('--prod') || process.env.NODE_ENV === 'production'
const PORT = Number(process.env.CLIMBR_API_PORT ?? (PROD ? process.env.PORT ?? 8787 : 8787))

const app = express()
app.use(express.json({ limit: '25mb' }))
const upload = multer({ dest: UPLOADS, limits: { fileSize: 1024 * 1024 * 1024 } })

app.get('/api/health', (_req, res) => res.json(health()))

// Verifies the key without spending anything: listing models is free.
app.get('/api/models', async (_req, res) => {
  if (!API_KEY) return res.status(503).json({ error: 'No VLMRUN_API_KEY configured.' })
  const r = await fetch(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${API_KEY}` } })
  const j = await r.json().catch(() => ({}))
  res.status(r.status).json({ models: (j.data ?? []).map((m) => ({ id: m.id, task: m.task, methods: m.methods })) })
})

app.get('/api/media/:id', (req, res) => {
  const file = path.join(MEDIA, path.basename(req.params.id))
  if (!fs.existsSync(file)) return res.status(404).end()
  res.sendFile(file)
})

// POST /api/analyze  (multipart: video, color, prompt?, maxPoseFrames?)
// Streams NDJSON: {type:"stage", …} … {type:"result", …} or {type:"error", …}
app.post('/api/analyze', upload.single('video'), async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')
  const send = (obj) => res.write(JSON.stringify(obj) + '\n')
  try {
    if (!req.file) throw httpError(400, 'No video uploaded.')
    send({ type: 'stage', stage: 'upload', status: 'done', detail: `${(req.file.size / 1e6).toFixed(1)} MB received` })
    send(await analyzeFile(req.file.path, req.body ?? {}, send))
  } catch (err) {
    send({ type: 'error', message: err.message ?? String(err), status: err.status ?? 500 })
  } finally {
    if (req.file) fs.rmSync(req.file.path, { force: true })
    res.end()
  }
})

// POST /api/coach  {analytics, frames?, exampleId?, mediaId?}
// The browser normally sends its own keyframes; without them the server cuts
// them from the example clip or a clip it transcoded.
app.post('/api/coach', async (req, res) => {
  try {
    const { analytics, frames, exampleId, mediaId } = req.body ?? {}
    let use = Array.isArray(frames) ? frames : []
    if (!use.length) {
      let file = null
      if (exampleId) file = path.join(ROOT, 'public', 'examples', path.basename(String(exampleId)), 'climb.mp4')
      if (mediaId) file = path.join(MEDIA, path.basename(String(mediaId)))
      if (file && fs.existsSync(file)) use = sampleFrames(file)
    }
    res.json(await coach({ analytics, frames: use }))
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message ?? String(err) })
  }
})

if (PROD) {
  const dist = path.join(ROOT, 'dist')
  app.use(express.static(dist))
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')))
}

app.listen(PORT, () => {
  const key = API_KEY ? `key …${API_KEY.slice(-4)}` : 'NO KEY (live analysis disabled)'
  console.log(`\n  CLIMBR API  http://localhost:${PORT}  ·  VLM Run ${key}  ·  ffmpeg ${hasFfmpeg() ? 'yes' : 'no'}\n`)
})
