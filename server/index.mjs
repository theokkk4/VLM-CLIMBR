// CLIMBR API for local runs and `npm start`: a thin Express wrapper around
// server/core.mjs. On Vercel the same core is served by api/*.js instead.
//
// The browser never sees the API key. It uploads a clip here; the core probes
// it, cuts the analysis and playback copies, asks SAM 3.1 to track the route's
// holds and ViTPose+ to track the climber, and progress streams back as NDJSON.
// The route itself is read in the browser (src/lib/analyze.ts).

import express from 'express'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import { API_KEY, BASE_URL, DEBUG, MEDIA, ROOT, WORK, analyzeFile, coach, hasFfmpeg, health, httpError, isMediaFile, listRuns, runDir, sampleFrames, saveClientReport } from './core.mjs'

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

// A run's playback copy, poster and original: /api/media/<run id>/<file>.
app.get('/api/media/:id/:file', (req, res) => {
  const dir = runDir(req.params.id)
  if (!dir || !isMediaFile(req.params.file)) return res.status(404).end()
  const file = path.join(dir, req.params.file)
  if (!fs.existsSync(file)) return res.status(404).end()
  res.sendFile(file, { dotfiles: 'allow' })
})
// Transcodes from before runs had folders.
app.get('/api/media/:id', (req, res) => {
  const file = path.join(MEDIA, path.basename(req.params.id))
  if (!fs.existsSync(file)) return res.status(404).end()
  res.sendFile(file, { dotfiles: 'allow' })
})

// POST /api/analyze  (multipart: video, color, prompt?)
// Streams NDJSON: {type:"stage", …} … then {type:"result", …} or {type:"error", stage, message}
app.post('/api/analyze', upload.single('video'), async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')
  const send = (obj) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n') }
  // The browser closed the stream (Cancel): stop ffmpeg and the gateway calls.
  const ctrl = new AbortController()
  res.on('close', () => { if (!res.writableFinished) ctrl.abort() })
  try {
    if (!req.file) throw Object.assign(httpError(400, 'No video uploaded.'), { stage: 'uploading' })
    send({ type: 'stage', stage: 'uploading', status: 'done', detail: `${(req.file.size / 1e6).toFixed(1)} MB received` })
    const { color, prompt } = req.body ?? {}
    send(await analyzeFile(req.file.path, { color, prompt, name: req.file.originalname, signal: ctrl.signal }, send))
  } catch (err) {
    send({ type: 'error', stage: err.stage ?? null, message: err.message ?? String(err), status: err.status ?? 500 })
  } finally {
    if (req.file) fs.rmSync(req.file.path, { force: true })
    res.end()
  }
})

// Development only: every run's log, its raw gateway responses, and the
// browser's report of what it read from them.
if (DEBUG) {
  app.get('/api/debug/runs', (_req, res) => res.json(listRuns()))
  app.get('/api/debug/runs/:id', (req, res) => {
    const dir = runDir(req.params.id)
    if (!dir || !fs.existsSync(path.join(dir, 'run.json'))) return res.status(404).json({ error: 'No such run.' })
    const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'))
    run.files = fs.readdirSync(dir).map((f) => ({ name: f, bytes: fs.statSync(path.join(dir, f)).size, url: `/api/debug/runs/${req.params.id}/${f}` }))
    res.json(run)
  })
  app.get('/api/debug/runs/:id/:file', (req, res) => {
    const dir = runDir(req.params.id)
    const name = path.basename(req.params.file)
    if (!dir || !fs.existsSync(path.join(dir, name))) return res.status(404).end()
    res.sendFile(path.join(dir, name), { dotfiles: 'allow' })
  })
  app.post('/api/debug/runs/:id/client', (req, res) => res.status(saveClientReport(req.params.id, req.body) ? 204 : 404).end())
}

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
      if (mediaId) {
        const [run, name] = String(mediaId).split('/')
        file = name ? (runDir(run) && isMediaFile(name) ? path.join(runDir(run), name) : null) : path.join(MEDIA, path.basename(run))
      }
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
  console.log(`\n  CLIMBR API  http://localhost:${PORT}  ·  VLM Run ${key}  ·  ffmpeg ${hasFfmpeg() ? 'yes' : 'NO (live analysis disabled)'}${DEBUG ? '  ·  debug: /api/debug/runs' : ''}\n`)
})
