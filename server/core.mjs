// Everything the API does, shared by the local Express server (server/index.mjs)
// and the Vercel functions (api/*.js): the VLM Run client, the SAM 3.1 + ViTPose+
// analysis, and the coach. The key is read here and never leaves the server.

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { coachPrompt, COACH_SYSTEM } from './coach.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const ON_VERCEL = Boolean(process.env.VERCEL)
// Vercel's filesystem is read-only except for /tmp.
export const WORK = ON_VERCEL ? path.join(os.tmpdir(), 'climbr') : path.join(ROOT, '.climbr')
export const MEDIA = path.join(WORK, 'media')
fs.mkdirSync(MEDIA, { recursive: true })

export const HOLD_MODEL = 'facebook/sam3.1'
export const POSE_MODEL = 'usyd-community/vitpose-plus-large'
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
export const env = (name, fallback) => process.env[name] || fileEnv[name] || fallback
export const API_KEY = env('VLMRUN_API_KEY', '')
export const BASE_URL = env('VLMRUN_BASE_URL', 'https://gateway.vlm.run/v1/openai')
// Tried in order. Free-tier keys are not entitled to every model, so a 403
// moves on to the next one, and whichever answered first is remembered.
const COACH_CHAIN = [...new Set([env('CLIMBR_COACH_MODEL', ''), 'google/gemini-3.7-flash', 'qwen/qwen3.8-27b', 'qwen/qwen3.5-0.8b'].filter(Boolean))]
let coachModel = null

// ── ffmpeg: the system one if installed, else the bundled static build ──────
const works = (bin) => { try { return spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0 } catch { return false } }
let FFMPEG = works('ffmpeg') ? 'ffmpeg' : null
if (!FFMPEG) {
  try {
    const p = (await import('ffmpeg-static')).default
    if (p && works(p)) FFMPEG = p
  } catch { /* not installed */ }
}
const FFPROBE = works('ffprobe') ? 'ffprobe' : null
export const hasFfmpeg = () => Boolean(FFMPEG)

export function health() {
  return {
    ok: true,
    connected: Boolean(API_KEY),
    gateway: BASE_URL.replace(/\/v1\/openai$/, ''),
    models: { holds: HOLD_MODEL, pose: POSE_MODEL, coach: coachModel ?? COACH_CHAIN[0] },
    ffmpeg: Boolean(FFMPEG),
    platform: ON_VERCEL ? 'vercel' : 'node',
    // On Vercel a clip is too big for a function's request body, so the
    // browser puts it in Blob storage first; that needs a Blob store.
    uploads: ON_VERCEL ? (process.env.BLOB_READ_WRITE_TOKEN ? 'blob' : 'none') : 'direct',
  }
}

// ── gateway ─────────────────────────────────────────────────────────────────
export function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

export async function chat(body, { timeoutMs = 15 * 60_000 } = {}) {
  if (!API_KEY) throw httpError(503, 'No VLMRUN_API_KEY configured. Add it to .env (local) or the project’s environment variables (Vercel).')
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
    return { content: json?.choices?.[0]?.message?.content, usage: json.usage ?? null, model: json.model ?? body.model }
  } finally {
    clearTimeout(timer)
  }
}

export function parseJsonContent(content) {
  if (content && typeof content === 'object') return content
  const text = String(content ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
  return JSON.parse(text)
}

// ── media ───────────────────────────────────────────────────────────────────
export function probe(file) {
  if (FFPROBE) {
    const out = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=width,height,r_frame_rate:stream_side_data=rotation:format=duration', '-of', 'json', file], { encoding: 'utf8' })
    if (out.status === 0) {
      try {
        const j = JSON.parse(out.stdout)
        const s = j.streams?.[0] ?? {}
        const [n, d] = String(s.r_frame_rate ?? '30/1').split('/').map(Number)
        const rotation = Math.abs(Number(s.side_data_list?.find((x) => 'rotation' in x)?.rotation ?? 0))
        const swap = rotation === 90 || rotation === 270
        return { width: swap ? s.height : s.width, height: swap ? s.width : s.height, fps: d ? n / d : 30, duration: Number(j.format?.duration ?? 0) }
      } catch { /* fall through */ }
    }
  }
  if (!FFMPEG) return null
  // No ffprobe (the static build ships ffmpeg only): read `ffmpeg -i`'s banner.
  const out = spawnSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr ?? ''
  const dur = out.match(/Duration: (\d+):(\d+):([\d.]+)/)
  const vid = out.match(/Video:.*?(\d{2,5})x(\d{2,5})/)
  const fps = out.match(/([\d.]+) fps/)
  const rot = /rotation of -?(90|270)/.test(out) || /displaymatrix: rotation of -?(90|270)/.test(out)
  if (!dur && !vid) return null
  const w = vid ? Number(vid[1]) : 0, h = vid ? Number(vid[2]) : 0
  return {
    width: rot ? h : w,
    height: rot ? w : h,
    fps: fps ? Number(fps[1]) : 30,
    duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
  }
}

export function transcode(input, output, onProgress) {
  // Long edge capped at 960: plenty for SAM and ViTPose, and it keeps the
  // base64 upload to the gateway small. 30 fps, H.264, no audio, SDR.
  const args = ['-y', '-v', 'error', '-progress', 'pipe:1', '-i', input,
    '-vf', "scale='if(gt(iw,ih),min(960,iw),-2)':'if(gt(iw,ih),-2,min(960,ih))',fps=30,format=yuv420p",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-an', '-movflags', '+faststart', output]
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args)
    let err = ''
    proc.stdout.on('data', (b) => {
      const m = String(b).match(/out_time_ms=(\d+)/g)
      if (m) onProgress?.(Number(m[m.length - 1].split('=')[1]) / 1e6)
    })
    proc.stderr.on('data', (b) => { err += b })
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err.slice(-400)}`))))
  })
}

// Keyframes for the coach, when the browser did not send its own.
export function sampleFrames(file, n = 8, width = 448) {
  if (!FFMPEG) return []
  const dur = probe(file)?.duration || 10
  const dir = fs.mkdtempSync(path.join(WORK, 'frames-'))
  try {
    const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-vf', `fps=${n}/${dur.toFixed(3)},scale=${width}:-2`, '-frames:v', String(n), '-q:v', '5', path.join(dir, 'f_%02d.jpg')])
    if (r.status !== 0) return []
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort()
      .map((f) => `data:image/jpeg;base64,${fs.readFileSync(path.join(dir, f)).toString('base64')}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// The label maps are full-resolution PNGs, one per sampled frame. The browser
// reads SAM's polygons instead, so the masks stop here.
function stripMasks(payload) {
  const frames = payload?.content?.frames
  if (Array.isArray(frames)) for (const f of frames) delete f.mask
  return payload
}

/**
 * The whole live analysis for one clip on disk: transcode, then SAM 3.1 and
 * ViTPose+ in parallel. `send` receives NDJSON-ready events. With `keep`, the
 * transcoded clip stays in MEDIA and the result says where to fetch it.
 */
export async function analyzeFile(file, { color = 'green', prompt: promptIn, maxPoseFrames, meta: hint, keep = true }, send) {
  const stage = (s, status, extra = {}) => send({ type: 'stage', stage: s, status, ...extra })
  if (!API_KEY) throw httpError(503, 'No VLMRUN_API_KEY configured on the CLIMBR server.')
  color = String(color).toLowerCase()
  const prompt = String(promptIn || '{color} climbing hold').replace('{color}', color)

  const id = randomUUID()
  const mp4 = path.join(MEDIA, `${id}.mp4`)
  let meta = probe(file) ?? hint ?? null
  stage('transcode', 'running')
  if (FFMPEG) {
    await transcode(file, mp4, (sec) => {
      if (meta?.duration) stage('transcode', 'running', { progress: Math.min(1, sec / meta.duration) })
    })
    meta = probe(mp4) ?? meta
    stage('transcode', 'done', { detail: meta ? `${meta.width}×${meta.height} · ${Number(meta.fps).toFixed(0)} fps · ${Number(meta.duration).toFixed(1)} s` : 'H.264' })
  } else {
    fs.copyFileSync(file, mp4)
    stage('transcode', 'skipped', { detail: 'ffmpeg not available — sending the clip as-is' })
  }
  meta = { width: 0, height: 0, fps: 30, duration: 0, ...(meta ?? {}) }

  const videoUrl = `data:video/mp4;base64,${fs.readFileSync(mp4).toString('base64')}`
  if (!keep) fs.rmSync(mp4, { force: true })
  const nFrames = Math.max(1, Math.round((meta.duration || 10) * (meta.fps || 30)))
  const skip = Math.max(1, Math.ceil(nFrames / TRACK_MAX_FRAMES))
  const maxPose = Math.min(Number(maxPoseFrames) || 900, nFrames)

  stage('holds', 'running', { detail: `SAM 3.1 · “${prompt}” · every ${skip} frames` })
  stage('pose', 'running', { detail: `ViTPose+ · ${maxPose} frames` })
  const t0 = Date.now()

  const holdsCall = chat({
    model: HOLD_MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'video_url', video_url: { url: videoUrl } }] }],
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
    stage('pose', 'done', { detail: `${(payload?.content?.frames ?? []).length} frames posed · ${((Date.now() - t0) / 1000).toFixed(1)} s` })
    return { payload, usage: r.usage }
  })

  const [holds, pose] = await Promise.all([holdsCall, poseCall])
  // Without a probe (no ffmpeg anywhere), the gateway's own envelope says what it decoded.
  if (!meta.width && pose.payload?.video_width) {
    meta = { ...meta, width: pose.payload.video_width, height: pose.payload.video_height, fps: pose.payload.video_fps ?? meta.fps, duration: pose.payload.video_duration ?? meta.duration }
  }
  return {
    type: 'result',
    id,
    video: keep ? `/api/media/${id}.mp4` : null,
    meta: { ...meta, color, prompt },
    holds: holds.payload,
    poses: pose.payload,
    usage: { holds: holds.usage, pose: pose.usage },
  }
}

/** Coach one climb. `frames` are JPEG data URLs (from the browser or sampleFrames). */
export async function coach({ analytics, frames = [] }) {
  if (!analytics) throw httpError(400, 'Missing analytics.')
  frames = frames.filter((f) => typeof f === 'string' && f.startsWith('data:image/')).slice(0, 12)
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
  }, { timeoutMs: 110_000 })

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
  return { feedback: parseJsonContent(r.content), model: r.model ?? coachModel, usage: r.usage, watchedVideo: watched, frames: watched ? frames.length : 0 }
}
