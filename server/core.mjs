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
import { normalizePose, normalizeSam } from './vlm.mjs'

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
    analysis: { fps: ANALYSIS_FPS, maxSeconds: MAX_CLIP_SECONDS },
    debug: DEBUG,
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

export async function chat(body, { timeoutMs = 15 * 60_000, signal } = {}) {
  if (!API_KEY) throw httpError(503, 'No VLMRUN_API_KEY configured. Add it to .env (local) or the project’s environment variables (Vercel).')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs)
  const cancel = () => ctrl.abort(new Error('cancelled'))
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await res.text()
    if (!res.ok) throw httpError(res.status, `${body.model} — gateway ${res.status}: ${text.slice(0, 400)}`)
    let json
    try { json = JSON.parse(text) } catch { throw httpError(502, `${body.model} — the gateway answered with something that is not JSON: ${text.slice(0, 200)}`) }
    const content = json?.choices?.[0]?.message?.content
    if (content == null) throw httpError(502, `${body.model} — the gateway's answer has no choices[0].message.content`)
    return { content, usage: json.usage ?? null, model: json.model ?? body.model }
  } catch (e) {
    if (ctrl.signal.aborted) throw httpError(signal?.aborted ? 499 : 504, signal?.aborted ? 'Cancelled.' : `${body.model} did not answer within ${Math.round(timeoutMs / 1000)} s.`)
    if (e.status) throw e
    throw httpError(502, `${body.model} — could not reach the VLM Run gateway: ${e.cause?.code ?? e.message}`)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

export function parseJsonContent(content) {
  if (content && typeof content === 'object') return content
  const text = String(content ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
  try {
    return JSON.parse(text)
  } catch {
    throw httpError(502, `The model's answer is not JSON: ${text.slice(0, 160)}${text.length > 160 ? '…' : ''}`)
  }
}

// ── media ───────────────────────────────────────────────────────────────────
// Every clip is read the same way, whatever the phone wrote: its metadata is
// probed, then one ffmpeg pass makes
//   · the analysis copy: exactly ANALYSIS_FPS frames a second (frame i is at
//     i / ANALYSIS_FPS s), upright, SDR, long edge ≤ 960. This is what SAM 3.1
//     and ViTPose+ see, so their frame ids are real timestamps.
//   · the playback copy: H.264, upright, SDR, ≤ 30 fps, which every browser plays.
// The original is kept beside them, untouched.

export const ANALYSIS_FPS = 10
const ANALYSIS_EDGE = 960
const PLAYBACK_EDGE = 1280
const PLAYBACK_MAX_FPS = 30
const POSTER_EDGE = 640
export const MAX_CLIP_SECONDS = 120 // SAM 3.1 samples ≤ 128 frames; past 2 min that is under one a second

const fitEdge = (edge) => `scale='if(gte(iw,ih),min(${edge},iw),-2)':'if(gte(iw,ih),-2,min(${edge},ih))'`
// HLG / PQ → BT.709. Without it an iPhone HDR clip reaches the models washed out.
const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,'

/** Exact frame count without decoding: one line per packet of the video stream. */
function countFrames(file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'framecrc', '-'], { encoding: 'utf8', maxBuffer: 256 << 20 })
  if (r.status !== 0) return 0
  return r.stdout.split('\n').filter((l) => l && !l.startsWith('#')).length
}

/**
 * {duration, fps, width, height, frameCount, sourceFormat, …} for the first
 * video stream, with width and height as displayed (rotation applied).
 * ffprobe when installed, else the bundled ffmpeg's own report. Throws when
 * the clip cannot be read; never fills in a value it did not measure.
 */
export function probeVideo(file, name = file) {
  if (!FFMPEG && !FFPROBE) throw httpError(500, 'ffmpeg is not available on the CLIMBR server, so the clip cannot be read.')
  const info = (FFPROBE && probeWithFfprobe(file)) || (FFMPEG && probeWithFfmpeg(file))
  if (!info) throw httpError(422, 'This file has no video stream ffmpeg can read.')
  const ext = path.extname(String(name)).slice(1).toLowerCase()
  info.container = ext || info.container
  info.sourceFormat = `${info.container}/${info.codec}${info.hdr ? ' HDR' : ''}`
  if (FFMPEG) {
    const counted = countFrames(file)
    if (counted) info.frameCount = counted
  }
  if (!info.frameCount && info.duration > 0 && info.fps > 0) info.frameCount = Math.round(info.duration * info.fps)
  // A container duration can include a trailing audio tail; the frames are the clip.
  if (info.frameCount && info.fps > 0 && !(info.duration > 0)) info.duration = info.frameCount / info.fps
  const bad = ['duration', 'fps', 'width', 'height', 'frameCount'].filter((k) => !(Number.isFinite(info[k]) && info[k] > 0))
  if (bad.length) throw httpError(422, `Could not read the clip's ${bad.join(', ')} (${info.sourceFormat}).`)
  return info
}

function probeWithFfprobe(file) {
  const out = spawnSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8', maxBuffer: 32 << 20 })
  if (out.status !== 0) return null
  let j
  try { j = JSON.parse(out.stdout) } catch { return null }
  const v = (j.streams ?? []).find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  if (!v) return null
  const rate = (r) => { const [n, d] = String(r ?? '').split('/').map(Number); return n > 0 && d > 0 ? n / d : 0 }
  const rot = Number(v.side_data_list?.find((d) => d.rotation != null)?.rotation ?? v.tags?.rotate ?? 0)
  const swap = Math.abs(Math.round(rot / 90)) % 2 === 1
  const brand = String(j.format?.tags?.major_brand ?? '').trim()
  return {
    width: swap ? v.height : v.width,
    height: swap ? v.width : v.height,
    fps: rate(v.avg_frame_rate) || rate(v.r_frame_rate),
    duration: Number(v.duration) || Number(j.format?.duration) || 0,
    frameCount: Number(v.nb_frames) || 0,
    codec: v.codec_name,
    container: brand === 'qt' ? 'mov' : String(j.format?.format_name ?? '').split(',')[0],
    rotation: rot,
    hdr: ['arib-std-b67', 'smpte2084'].includes(v.color_transfer),
    hasAudio: (j.streams ?? []).some((s) => s.codec_type === 'audio'),
    bytes: Number(j.format?.size) || fs.statSync(file).size,
  }
}

function probeWithFfmpeg(file) {
  // The static build ships no ffprobe: read `ffmpeg -i`'s report instead.
  const out = spawnSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr ?? ''
  const lines = out.split('\n')
  const at = lines.findIndex((l) => /Stream #\d+:\d+.*: Video: /.test(l) && !/attached pic/.test(l))
  if (at < 0) return null
  const vline = lines[at]
  // Side data (the display matrix) is listed under its stream, before the next one.
  let rot = 0
  for (let i = at + 1; i < lines.length && !/^\s*Stream #/.test(lines[i]); i++) {
    const m = lines[i].match(/rotation of (-?[\d.]+) degrees/)
    if (m) rot = Number(m[1])
  }
  const dims = vline.match(/, (\d{2,5})x(\d{2,5})[\s,[]/)
  const fps = Number(vline.match(/, ([\d.]+) fps/)?.[1] ?? vline.match(/, ([\d.]+) tbr/)?.[1] ?? 0)
  const dur = out.match(/Duration: (\d+):(\d+):([\d.]+)/)
  const swap = Math.abs(Math.round(rot / 90)) % 2 === 1
  const w = dims ? Number(dims[1]) : 0, h = dims ? Number(dims[2]) : 0
  return {
    width: swap ? h : w,
    height: swap ? w : h,
    fps,
    duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
    frameCount: 0,
    codec: vline.match(/Video: (\w+)/)?.[1] ?? 'unknown',
    container: out.match(/Input #0, ([\w]+)/)?.[1] ?? '',
    rotation: rot,
    hdr: /arib-std-b67|smpte2084/.test(vline),
    hasAudio: /Stream #\d+:\d+.*: Audio: /.test(out),
    bytes: fs.statSync(file).size,
  }
}

function runFfmpeg(args, { onProgress, duration, signal } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', ...args])
    let err = ''
    const stop = () => proc.kill('SIGKILL')
    signal?.addEventListener('abort', stop, { once: true })
    proc.stdout.on('data', (b) => {
      const m = String(b).match(/out_time_us=(\d+)/g)
      if (m && duration) onProgress?.(Math.min(1, Number(m[m.length - 1].split('=')[1]) / 1e6 / duration))
    })
    proc.stderr.on('data', (b) => { err += b })
    proc.on('error', reject)
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', stop)
      if (signal?.aborted) reject(httpError(499, 'Cancelled.'))
      else if (code === 0) resolve()
      else reject(httpError(500, `ffmpeg failed: ${err.trim().slice(-400)}`))
    })
  })
}

/** One decode of the original → the analysis copy, the playback copy (and a VP9
 *  copy when CLIMBR_WEBM is set), then a poster from the playback copy. */
export async function extractMedia(original, dir, src, { onProgress, signal } = {}) {
  const webm = Boolean(env('CLIMBR_WEBM', ''))
  const pre = `${src.hdr ? TONEMAP : ''}format=yuv420p`
  const playRate = src.fps > PLAYBACK_MAX_FPS + 0.5 ? `fps=${PLAYBACK_MAX_FPS},` : ''
  const branches = webm ? 3 : 2
  const graph = `[0:v]${pre},split=${branches}[a][p]${webm ? '[w]' : ''};` +
    `[a]fps=${ANALYSIS_FPS},${fitEdge(ANALYSIS_EDGE)},setsar=1[ao];` +
    `[p]${playRate}${fitEdge(PLAYBACK_EDGE)},setsar=1[po]` +
    (webm ? `;[w]${playRate}${fitEdge(PLAYBACK_EDGE)},setsar=1[wo]` : '')
  const files = {
    analysis: path.join(dir, 'analysis.mp4'),
    playback: path.join(dir, 'play.mp4'),
    webm: webm ? path.join(dir, 'play.webm') : null,
    poster: path.join(dir, 'poster.jpg'),
  }
  const h264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart']
  await runFfmpeg([
    '-i', original, '-filter_complex', graph,
    '-map', '[ao]', ...h264, '-crf', '22', files.analysis,
    '-map', '[po]', ...h264, '-crf', '23', '-profile:v', 'high', files.playback,
    ...(webm ? ['-map', '[wo]', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-crf', '36', '-b:v', '0', '-an', files.webm] : []),
  ], { onProgress, duration: src.duration, signal })
  const analysis = probeVideo(files.analysis)
  const playback = probeVideo(files.playback)
  if (Math.abs(analysis.fps - ANALYSIS_FPS) > 0.01) throw httpError(500, `The analysis copy came out at ${analysis.fps} fps, not ${ANALYSIS_FPS}.`)
  await runFfmpeg(['-ss', String(Math.min(1, playback.duration / 3).toFixed(3)), '-i', files.playback, '-frames:v', '1', '-vf', fitEdge(POSTER_EDGE), '-q:v', '4', files.poster], { signal })
  return {
    files,
    analysis: { fps: ANALYSIS_FPS, width: analysis.width, height: analysis.height, frameCount: analysis.frameCount, duration: round3(analysis.frameCount / ANALYSIS_FPS) },
    playback: { width: playback.width, height: playback.height, fps: round3(playback.fps), frameCount: playback.frameCount, duration: round3(playback.duration) },
  }
}

const round3 = (v) => Math.round(v * 1000) / 1000

// Keyframes for the coach, when the browser did not send its own.
export function sampleFrames(file, n = 8, width = 448) {
  if (!FFMPEG) return []
  let dur
  try { dur = probeVideo(file).duration } catch { return [] }
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

// The label maps are full-resolution PNGs, one per sampled frame. CLIMBR reads
// SAM's polygons instead, so the masks stop here.
function stripMasks(payload) {
  const frames = payload?.content?.frames
  if (Array.isArray(frames)) for (const f of frames) delete f.mask
  return payload
}

// ── runs: one folder per analysis ───────────────────────────────────────────
// .climbr/runs/<id>/ holds the original, the analysis and playback copies, the
// poster and, in development, the raw gateway responses and a run.json log
// (served at /api/debug/runs/<id>).
export const RUNS = path.join(WORK, 'runs')
fs.mkdirSync(RUNS, { recursive: true })
export const DEBUG = !ON_VERCEL && (Boolean(env('CLIMBR_DEBUG', '')) || (process.env.NODE_ENV !== 'production' && !process.argv.includes('--prod')))
const RUN_ID = /^[0-9a-f-]{36}$/
export const runDir = (id) => (RUN_ID.test(String(id)) ? path.join(RUNS, id) : null)
const MEDIA_FILES = new Set(['play.mp4', 'play.webm', 'poster.jpg'])
export const isMediaFile = (name) => MEDIA_FILES.has(name) || /^original\.[a-z0-9]{1,5}$/.test(name)

function writeJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 1)) } catch (e) { console.warn(`[climbr] could not write ${file}: ${e.message}`) }
}

export function listRuns() {
  return fs.readdirSync(RUNS).filter((d) => RUN_ID.test(d)).map((id) => {
    try { return JSON.parse(fs.readFileSync(path.join(RUNS, id, 'run.json'), 'utf8')) } catch { return { id } }
  }).map((r) => ({ id: r.id, name: r.source?.name, startedAt: r.startedAt, status: r.status, error: r.error ?? null, summary: r.summary ?? null }))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
}

/**
 * The whole server side of a live analysis, for one clip on disk:
 *   extracting_frames → (segmenting ‖ estimating_pose)
 * `send` receives NDJSON-ready stage events. Each stage either finishes or
 * fails with its own message; a failure is never papered over with defaults.
 * The route itself is read in the browser (src/lib/analyze.ts).
 */
export async function analyzeFile(file, { color = 'green', prompt: promptIn, name = 'clip.mp4', publish, signal } = {}, send) {
  const id = randomUUID()
  const dir = path.join(RUNS, id)
  fs.mkdirSync(dir, { recursive: true })
  const run = { id, startedAt: new Date().toISOString(), status: 'running', stages: {}, warnings: [], source: { name } }
  const t0 = Date.now()
  const stage = (s, status, extra = {}) => {
    const rec = (run.stages[s] ??= { startedAt: Date.now() - t0 })
    Object.assign(rec, { status, ...extra.detail != null ? { detail: extra.detail } : {} })
    if (status === 'done' || status === 'error') rec.seconds = Math.round(Date.now() - t0 - rec.startedAt) / 1000
    send({ type: 'stage', stage: s, status, ...extra })
  }
  const fail = (s, err) => {
    err.stage ??= s
    stage(s, 'error', { detail: err.message })
    return err
  }
  const log = (...a) => DEBUG && console.log('[climbr]', id.slice(0, 8), ...a)
  const finish = (status, extra) => {
    Object.assign(run, { status, finishedAt: new Date().toISOString(), seconds: (Date.now() - t0) / 1000, ...extra })
    if (DEBUG) writeJson(path.join(dir, 'run.json'), run)
  }

  try {
    if (!API_KEY) throw httpError(503, 'No VLMRUN_API_KEY configured on the CLIMBR server.')
    color = String(color).toLowerCase().replace(/[^a-z ]/g, '').trim() || 'green'
    const prompt = String(promptIn || '{color} climbing hold').replace('{color}', color).slice(0, 120)

    // ── extracting_frames ──
    stage('extracting_frames', 'running', { detail: 'Reading the clip' })
    let src, media
    try {
      if (!FFMPEG) throw httpError(500, 'ffmpeg is not available on the CLIMBR server (install it, or run `npm install` to fetch ffmpeg-static).')
      const ext = (path.extname(name).toLowerCase().match(/^\.[a-z0-9]{1,5}$/) ?? ['.mp4'])[0]
      const original = path.join(dir, `original${ext}`)
      try { fs.renameSync(file, original) } catch { fs.copyFileSync(file, original) }
      src = { name, ...probeVideo(original, name) }
      run.source = src
      log('source', JSON.stringify(src))
      if (src.duration > MAX_CLIP_SECONDS) throw httpError(422, `The clip is ${src.duration.toFixed(0)} s long; CLIMBR reads clips up to ${MAX_CLIP_SECONDS} s. Trim it to the climb and try again.`)
      stage('extracting_frames', 'running', { detail: `${src.width}×${src.height} · ${round3(src.fps)} fps · ${src.duration.toFixed(2)} s · ${src.frameCount} frames`, progress: 0 })
      media = await extractMedia(original, dir, src, { signal, onProgress: (p) => stage('extracting_frames', 'running', { progress: p }) })
      run.analysis = media.analysis
      run.playback = media.playback
      log('analysis', JSON.stringify(media.analysis), 'playback', JSON.stringify(media.playback))
    } catch (e) {
      throw fail('extracting_frames', e)
    }
    const A = media.analysis
    stage('extracting_frames', 'done', {
      detail: `${src.width}×${src.height} · ${round3(src.fps)} fps · ${src.duration.toFixed(2)} s → ${A.frameCount} frames at ${ANALYSIS_FPS} fps`,
      data: { source: src, analysis: A, playback: media.playback },
    })

    // ── segmenting ‖ estimating_pose ──
    const videoUrl = `data:video/mp4;base64,${fs.readFileSync(media.files.analysis).toString('base64')}`
    const skip = Math.max(1, Math.ceil(A.frameCount / TRACK_MAX_FRAMES))
    const samples = Math.ceil(A.frameCount / skip)
    const timeoutMs = ON_VERCEL ? 270_000 : 10 * 60_000
    stage('segmenting', 'running', { detail: `SAM 3.1 · “${prompt}” · ${samples} frames, one every ${(skip / ANALYSIS_FPS).toFixed(1)} s` })
    stage('estimating_pose', 'running', { detail: `ViTPose+ · ${A.frameCount} frames at ${ANALYSIS_FPS} fps` })
    const expect = { width: A.width, height: A.height, fps: ANALYSIS_FPS, frameCount: A.frameCount, duration: A.duration }

    const segment = chat({
      model: HOLD_MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'video_url', video_url: { url: videoUrl } }] }],
      response_format: { type: 'json_object' },
      method: 'track',
      method_params: { prompt, video_skip_frames: skip, video_max_frames: TRACK_MAX_FRAMES, polygons: true, mask_format: 'png' },
    }, { timeoutMs, signal }).then((r) => {
      const raw = stripMasks(parseJsonContent(r.content))
      if (DEBUG) writeJson(path.join(dir, 'sam.raw.json'), raw)
      const sam = normalizeSam(raw, expect)
      if (DEBUG) writeJson(path.join(dir, 'sam.json'), sam)
      log('SAM 3.1', JSON.stringify({ envelope: sam.envelope, coords: sam.coords, samples: sam.samples.length, tracks: sam.tracks, detections: sam.detections.length, dropped: sam.dropped, checks: sam.checks.filter((c) => !c.ok) }))
      run.sam = { samples: sam.samples.length, tracks: sam.tracks, detections: sam.detections.length, coords: sam.coords, checks: sam.checks, usage: r.usage }
      stage('segmenting', 'done', { detail: `${sam.tracks} ${color} hold track${sam.tracks === 1 ? '' : 's'} · ${sam.detections.length} masks in ${sam.samples.length} frames`, data: run.sam })
      return { sam, usage: r.usage }
    }).catch((e) => { throw fail('segmenting', e) })

    const poseCall = chat({
      model: POSE_MODEL,
      messages: [{ role: 'user', content: [{ type: 'video_url', video_url: { url: videoUrl } }] }],
      response_format: { type: 'json_object' },
      method: 'pose',
      video_fps: ANALYSIS_FPS,
      video_max_frames: A.frameCount,
      precision: 4,
    }, { timeoutMs, signal }).then((r) => {
      const raw = parseJsonContent(r.content)
      if (DEBUG) writeJson(path.join(dir, 'pose.raw.json'), raw)
      const pose = normalizePose(raw, expect)
      if (DEBUG) writeJson(path.join(dir, 'pose.json'), pose)
      const span = pose.frames.length ? [pose.frames[0].timestamp, pose.frames[pose.frames.length - 1].timestamp] : null
      log('ViTPose+', JSON.stringify({ envelope: pose.envelope, coords: pose.coords, framesPosed: pose.framesPosed, people: pose.people, span, dropped: pose.dropped, checks: pose.checks.filter((c) => !c.ok) }))
      run.pose = { framesPosed: pose.framesPosed, people: pose.people, span, coords: pose.coords, checks: pose.checks, usage: r.usage }
      stage('estimating_pose', 'done', { detail: `${pose.framesPosed} frames posed${span ? ` · ${span[0].toFixed(1)}–${span[1].toFixed(1)} s` : ''} · ${pose.people} ${pose.people === 1 ? 'person' : 'people'} tracked`, data: run.pose })
      return { pose, usage: r.usage }
    }).catch((e) => { throw fail('estimating_pose', e) })

    const [segR, poseR] = await Promise.allSettled([segment, poseCall])
    const failed = [segR, poseR].filter((r) => r.status === 'rejected').map((r) => r.reason)
    if (failed.length) {
      const err = failed[0]
      if (failed.length > 1) err.message = failed.map((e) => e.message).join(' · ')
      throw err
    }
    const { sam } = segR.value, { pose } = poseR.value
    const warnings = [...sam.warnings, ...pose.warnings,
      ...[...sam.checks, ...pose.checks].filter((c) => !c.ok).map((c) => `Gateway ${c.name} mismatch: ${c.detail}.`)]
    run.warnings = warnings

    const names = { playback: 'play.mp4', poster: 'poster.jpg', ...(media.files.webm ? { webm: 'play.webm' } : {}) }
    const urls = publish
      ? await publish(id, Object.fromEntries(Object.entries(names).map(([k, f]) => [k, path.join(dir, f)])))
      : Object.fromEntries(Object.entries(names).map(([k, f]) => [k, `/api/media/${id}/${f}`]))
    if (!DEBUG) fs.rmSync(media.files.analysis, { force: true })

    const result = {
      type: 'result',
      id,
      color,
      prompt,
      source: src,
      analysis: A,
      playback: { ...media.playback, src: urls.playback, webm: urls.webm ?? null, poster: urls.poster },
      sam,
      pose,
      usage: { holds: segR.value.usage, pose: poseR.value.usage },
      warnings,
      debug: DEBUG ? `/api/debug/runs/${id}` : null,
    }
    finish('analyzed', { summary: { duration: src.duration, frames: src.frameCount, analysisFrames: A.frameCount, samSamples: sam.samples.length, samTracks: sam.tracks, samDetections: sam.detections.length, poseFrames: pose.framesPosed } })
    return result
  } catch (err) {
    finish('error', { error: { stage: err.stage ?? null, message: err.message, status: err.status ?? 500 } })
    log('error', err.stage ?? '', err.message)
    throw err
  } finally {
    // A function's /tmp is not storage: what the browser needs was published.
    if (ON_VERCEL) fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** The browser's half of a run (the route it read, the checks it ran), kept with
 *  the server's half so one folder tells the whole story. Development only. */
export function saveClientReport(id, report) {
  const dir = runDir(id)
  if (!DEBUG || !dir || !fs.existsSync(dir)) return false
  writeJson(path.join(dir, 'client.json'), report)
  try {
    const runFile = path.join(dir, 'run.json')
    const run = JSON.parse(fs.readFileSync(runFile, 'utf8'))
    run.client = { status: report?.status, summary: report?.summary, validation: report?.validation, at: new Date().toISOString() }
    run.status = report?.status ?? run.status
    writeJson(runFile, run)
  } catch { /* run.json missing: the client report still stands alone */ }
  return true
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
