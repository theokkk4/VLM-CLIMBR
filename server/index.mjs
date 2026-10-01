// CLIMBR API — a thin, key-holding proxy in front of the VLM Run gateway.
//
// The browser never sees the API key. It uploads a clip here; this server
// transcodes it (when ffmpeg is installed), asks SAM 3.1 to track the route's
// holds and ViTPose+ to track the climber, and streams progress back as NDJSON.
// The route itself is read in the browser (src/lib/analyze.ts), so the same
// code path serves a live run and a pasted gateway payload.

import express from 'express'
import multer from 'multer'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { coachPrompt, COACH_SYSTEM } from './coach.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORK = path.join(ROOT, '.climbr')
const UPLOADS = path.join(WORK, 'uploads')
const MEDIA = path.join(WORK, 'media')
for (const dir of [UPLOADS, MEDIA]) fs.mkdirSync(dir, { recursive: true })

const PROD = process.argv.includes('--prod') || process.env.NODE_ENV === 'production'
const PORT = Number(process.env.CLIMBR_API_PORT ?? (PROD ? process.env.PORT ?? 8787 : 8787))
const HOLD_MODEL = 'facebook/sam3.1'
const POSE_MODEL = 'usyd-community/vitpose-plus-large'
const TRACK_MAX_FRAMES = 128 // the gateway's cap on SAM 3.1 tracking samples

// ── key loading: an exported VLMRUN_API_KEY wins, else the nearest .env ─────
function loadEnv() {
  const found = {}
  for (let dir = ROOT; ; dir = path.dirname(dir)) {
    const file = path.join(dir, '.env')
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
        if (m) found[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
      }
      break
    }
    if (dir === path.dirname(dir)) break
  }
  return found
}
const fileEnv = loadEnv()
const env = (name, fallback) => process.env[name] || fileEnv[name] || fallback
const API_KEY = env('VLMRUN_API_KEY', '')
const BASE_URL = env('VLMRUN_BASE_URL', 'https://gateway.vlm.run/v1/openai')
// Tried in order. Free-tier keys are not entitled to every model, so a 403
// moves on to the next one, and whichever answered first is remembered.
const COACH_CHAIN = [...new Set([env('CLIMBR_COACH_MODEL', ''), 'google/gemini-3.7-flash', 'qwen/qwen3.8-27b', 'qwen/qwen3.5-0.8b'].filter(Boolean))]
let coachModel = null

const has = (bin) => spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0
const FFMPEG = has('ffmpeg')
const FFPROBE = has('ffprobe')

// ── gateway ─────────────────────────────────────────────────────────────────
async function chat(body, { timeoutMs = 15 * 60_000 } = {}) {
  if (!API_KEY) throw httpError(503, 'No VLMRUN_API_KEY configured. Copy .env.example to .env and add your key.')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await res.text()
    if (!res.ok) throw httpError(res.status, `Gateway ${res.status}: ${text.slice(0, 400)}`)
    const json = JSON.parse(text)
    const content = json?.choices?.[0]?.message?.content
    return { content, usage: json.usage ?? null, model: json.model ?? body.model }
  } finally {
    clearTimeout(timer)
  }
}

function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

function parseJsonContent(content) {
  if (content && typeof content === 'object') return content
  const text = String(content ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
  return JSON.parse(text)
}

// ── media ───────────────────────────────────────────────────────────────────
function probe(file) {
  if (!FFPROBE) return null
  const out = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height,r_frame_rate,nb_frames:stream_side_data=rotation:format=duration',
    '-of', 'json', file], { encoding: 'utf8' })
  if (out.status !== 0) return null
  try {
    const j = JSON.parse(out.stdout)
    const s = j.streams?.[0] ?? {}
    const [n, d] = String(s.r_frame_rate ?? '30/1').split('/').map(Number)
    const rotation = Math.abs(Number(s.side_data_list?.find((x) => 'rotation' in x)?.rotation ?? 0))
    const swap = rotation === 90 || rotation === 270
    return {
      width: swap ? s.height : s.width,
      height: swap ? s.width : s.height,
      fps: d ? n / d : 30,
      duration: Number(j.format?.duration ?? 0),
    }
  } catch {
    return null
  }
}

function transcode(input, output, onProgress) {
  // Long edge capped at 960: plenty for SAM and ViTPose, and it keeps the
  // base64 upload to the gateway small. 30 fps, H.264, no audio, SDR.
  const args = ['-y', '-v', 'error', '-progress', 'pipe:1', '-i', input,
    '-vf', "scale='if(gt(iw,ih),min(960,iw),-2)':'if(gt(iw,ih),-2,min(960,ih))',fps=30,format=yuv420p",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-an', '-movflags', '+faststart', output]
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args)
    let err = ''
    proc.stdout.on('data', (b) => {
      const m = String(b).match(/out_time_ms=(\d+)/g)
      if (m) onProgress?.(Number(m[m.length - 1].split('=')[1]) / 1e6)
    })
    proc.stderr.on('data', (b) => { err += b })
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err.slice(-400)}`))))
  })
}

// Keyframes for the coach. Sent as images rather than one video_url: not every
// chat model on the gateway decodes video, but all the vision ones read images,
// and a handful of evenly spaced frames is what a coach needs to see posture.
function sampleFrames(file, n = 8, width = 448) {
  if (!FFMPEG) return []
  const meta = probe(file)
  const dur = meta?.duration || 10
  const dir = fs.mkdtempSync(path.join(WORK, 'frames-'))
  try {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `fps=${n}/${dur.toFixed(3)},scale=${width}:-2`, '-frames:v', String(n), '-q:v', '5', path.join(dir, 'f_%02d.jpg')])
    if (r.status !== 0) return []
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort()
      .map((f) => `data:image/jpeg;base64,${fs.readFileSync(path.join(dir, f)).toString('base64')}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ── app ─────────────────────────────────────────────────────────────────────
const app = express()
app.use(express.json({ limit: '25mb' }))
const upload = multer({ dest: UPLOADS, limits: { fileSize: 1024 * 1024 * 1024 } })

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    connected: Boolean(API_KEY),
    gateway: BASE_URL.replace(/\/v1\/openai$/, ''),
    models: { holds: HOLD_MODEL, pose: POSE_MODEL, coach: coachModel ?? COACH_CHAIN[0] },
    ffmpeg: FFMPEG,
  })
})

// Verifies the key without spending anything: listing models is free.
app.get('/api/models', async (_req, res) => {
  if (!API_KEY) return res.status(503).json({ error: 'No VLMRUN_API_KEY configured.' })
  const r = await fetch(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${API_KEY}` } })
  const j = await r.json().catch(() => ({}))
  res.status(r.status).json({ models: (j.data ?? []).map((m) => ({ id: m.id, task: m.task, methods: m.methods })) })
})

app.get('/api/media/:id', (req, res) => {
  const id = path.basename(req.params.id)
  const file = path.join(MEDIA, id)
  if (!fs.existsSync(file)) return res.status(404).end()
  res.sendFile(file)
})

// POST /api/analyze  (multipart: video, color, prompt?, maxPoseFrames?)
// Streams NDJSON: {type:"stage", stage, status, detail?, progress?} … {type:"result", …}
app.post('/api/analyze', upload.single('video'), async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')
  const send = (obj) => res.write(JSON.stringify(obj) + '\n')
  const stage = (stage, status, extra = {}) => send({ type: 'stage', stage, status, ...extra })

  try {
    if (!req.file) throw httpError(400, 'No video uploaded.')
    if (!API_KEY) throw httpError(503, 'No VLMRUN_API_KEY configured on the CLIMBR server.')
    const color = String(req.body.color || 'green').toLowerCase()
    const prompt = String(req.body.prompt || '{color} climbing hold').replace('{color}', color)
    stage('upload', 'done', { detail: `${(req.file.size / 1e6).toFixed(1)} MB received` })

    const id = randomUUID()
    const mp4 = path.join(MEDIA, `${id}.mp4`)
    let meta = probe(req.file.path)
    stage('transcode', 'running')
    if (FFMPEG) {
      await transcode(req.file.path, mp4, (sec) => {
        if (meta?.duration) stage('transcode', 'running', { progress: Math.min(1, sec / meta.duration) })
      })
      meta = probe(mp4) ?? meta
      stage('transcode', 'done', { detail: meta ? `${meta.width}×${meta.height} · ${meta.fps.toFixed(0)} fps · ${meta.duration.toFixed(1)} s` : 'H.264' })
    } else {
      fs.copyFileSync(req.file.path, mp4)
      stage('transcode', 'skipped', { detail: 'ffmpeg not installed — sending the clip as-is' })
    }
    fs.rmSync(req.file.path, { force: true })
    meta = meta ?? { width: 0, height: 0, fps: 30, duration: 0 }

    const b64 = fs.readFileSync(mp4).toString('base64')
    const videoUrl = `data:video/mp4;base64,${b64}`
    const nFrames = Math.max(1, Math.round((meta.duration || 10) * (meta.fps || 30)))
    const skip = Math.max(1, Math.ceil(nFrames / TRACK_MAX_FRAMES))
    const maxPose = Math.min(Number(req.body.maxPoseFrames) || 900, nFrames)

    stage('holds', 'running', { detail: `SAM 3.1 · “${prompt}” · every ${skip} frames` })
    stage('pose', 'running', { detail: `ViTPose+ · ${maxPose} frames` })
    const t0 = Date.now()

    const holdsCall = chat({
      model: HOLD_MODEL,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'video_url', video_url: { url: videoUrl } },
      ] }],
      response_format: { type: 'json_object' },
      method: 'track',
      method_params: { prompt, video_skip_frames: skip, video_max_frames: TRACK_MAX_FRAMES, polygons: true, mask_format: 'png' },
    }).then((r) => {
      const payload = stripMasks(parseJsonContent(r.content))
      const n = new Set((payload?.content?.items ?? []).map((i) => i.track_id)).size
      stage('holds', 'done', { detail: `${n} ${color} holds tracked · ${((Date.now() - t0) / 1000).toFixed(1)} s` })
      return { payload, usage: r.usage }
    })

    const poseCall = chat({
      model: POSE_MODEL,
      messages: [{ role: 'user', content: [{ type: 'video_url', video_url: { url: videoUrl } }] }],
      response_format: { type: 'json_object' },
      method: 'pose',
      video_fps: meta.fps || 30,
      video_max_frames: maxPose,
      precision: 4,
    }).then((r) => {
      const payload = parseJsonContent(r.content)
      const n = (payload?.content?.frames ?? []).length
      stage('pose', 'done', { detail: `${n} frames posed · ${((Date.now() - t0) / 1000).toFixed(1)} s` })
      return { payload, usage: r.usage }
    })

    const [holds, pose] = await Promise.all([holdsCall, poseCall])
    send({
      type: 'result',
      id,
      video: `/api/media/${id}.mp4`,
      meta: { ...meta, color, prompt },
      holds: holds.payload,
      poses: pose.payload,
      usage: { holds: holds.usage, pose: pose.usage },
    })
  } catch (err) {
    send({ type: 'error', message: err.message ?? String(err), status: err.status ?? 500 })
  } finally {
    if (req.file) fs.rmSync(req.file.path, { force: true })
    res.end()
  }
})

// The label maps are full-resolution PNGs, one per sampled frame. The browser
// reads SAM's polygons instead, so the masks stop here.
function stripMasks(payload) {
  const frames = payload?.content?.frames
  if (Array.isArray(frames)) for (const f of frames) delete f.mask
  return payload
}

// POST /api/coach  {analytics, exampleId?, mediaId?}
app.post('/api/coach', async (req, res) => {
  try {
    const { analytics, exampleId, mediaId, withVideo = true } = req.body ?? {}
    if (!analytics) throw httpError(400, 'Missing analytics.')
    let videoFile = null
    if (withVideo && exampleId) videoFile = path.join(ROOT, 'public', 'examples', path.basename(String(exampleId)), 'climb.mp4')
    if (withVideo && mediaId) videoFile = path.join(MEDIA, path.basename(String(mediaId)))
    if (videoFile && !fs.existsSync(videoFile)) videoFile = null

    const frames = videoFile ? sampleFrames(videoFile) : []
    const content = [{ type: 'text', text: coachPrompt(analytics, frames.length) }]
    for (const url of frames) content.push({ type: 'image_url', image_url: { url } })

    const ask = (model, parts) => chat({
      model,
      messages: [{ role: 'system', content: COACH_SYSTEM }, { role: 'user', content: parts }],
      response_format: { type: 'json_object' },
      temperature: 0.4,
      max_tokens: 2500,
      // Qwen 3.x reasons before it answers and can spend the whole budget
      // thinking; the coach wants the answer, so thinking is switched off.
      ...(model.startsWith('qwen/') ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    }, { timeoutMs: 150_000 })

    const order = coachModel ? [coachModel, ...COACH_CHAIN.filter((m) => m !== coachModel)] : COACH_CHAIN
    let r = null, watched = false, lastErr = null
    for (const model of order) {
      for (const parts of frames.length ? [content, content.filter((c) => c.type === 'text')] : [content]) {
        try {
          r = await ask(model, parts)
          const j = parseJsonContent(r.content) // a reply that is not JSON counts as a failure
          if (!j?.headline || !Array.isArray(j?.focus ?? j?.strengths)) throw httpError(502, `${model} answered off-shape`)
          watched = parts.length > 1
          coachModel = model
          break
        } catch (e) {
          lastErr = e
          r = null
          if (e.status === 403 || e.status === 404) break // not entitled: next model
        }
      }
      if (r) break
    }
    if (!r) throw lastErr ?? httpError(502, 'No coach model answered.')
    res.json({ feedback: parseJsonContent(r.content), model: r.model ?? coachModel, usage: r.usage, watchedVideo: watched, frames: watched ? frames.length : 0 })
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
  console.log(`\n  CLIMBR API  http://localhost:${PORT}  ·  VLM Run ${key}  ·  ffmpeg ${FFMPEG ? 'yes' : 'no'}\n`)
})
