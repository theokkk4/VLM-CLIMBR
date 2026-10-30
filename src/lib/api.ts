// The browser's side of the CLIMBR server: health, and the live analysis stream.

import { buildSession, type SessionParts } from './session'
import type { ClimbrManifest, PipelineClimb, PipelineComparison, PipelineHold, PipelineSequence, Session } from './types'
import { checkResult, type AnalyzeResult } from './vlm'

export interface Health {
  ok: boolean
  connected: boolean
  canSaveKey?: boolean
  gateway?: string
  models?: { holds: string; pose: string; coach: string }
  ffmpeg?: boolean
  analysis?: { fps: number; maxSeconds: number }
  debug?: boolean
  platform?: 'node' | 'vercel'
  uploads?: 'direct' | 'blob' | 'none'
}

export interface KeyCheck { ok: boolean; status: number; error: string | null; models: string[]; missing?: string[]; coach?: string[]; saved?: boolean; health?: Health }

/** What the configured key can do, straight from the gateway. */
export async function checkModels(): Promise<KeyCheck> {
  try {
    const r = await fetch('/api/models')
    return await r.json()
  } catch {
    return { ok: false, status: 0, error: 'Could not reach the CLIMBR server. Is `npm run dev` running?', models: [] }
  }
}

/** Test a key against the gateway; the server saves it only when it works. */
export async function connectKey(key: string): Promise<KeyCheck> {
  try {
    const r = await fetch('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) })
    const j = await r.json().catch(() => ({}))
    return { ok: false, status: r.status, models: [], error: `Server ${r.status}`, ...j }
  } catch {
    return { ok: false, status: 0, error: 'Could not reach the CLIMBR server. Is `npm run dev` running?', models: [] }
  }
}

export async function health(): Promise<Health> {
  try {
    const r = await fetch('/api/health')
    if (!r.ok) return { ok: false, connected: false }
    return await r.json()
  } catch {
    return { ok: false, connected: false }
  }
}

/** The run's stages, in order. The server reports the first four; the browser
 *  reads the route and, if it can, asks the coach. */
export const STAGE_KEYS = ['uploading', 'extracting_frames', 'segmenting', 'estimating_pose', 'analyzing_moves', 'coaching'] as const
export type StageKey = (typeof STAGE_KEYS)[number]
export interface StageEvent { type: 'stage'; stage: StageKey; status: 'running' | 'done' | 'skipped' | 'error'; detail?: string; progress?: number; data?: any }

/** A failure, tagged with the stage it happened in. */
export class StageError extends Error {
  stage: StageKey | null
  constructor(message: string, stage: StageKey | null) {
    super(message)
    this.stage = stage
  }
}

export interface LiveOptions { color: string; health: Health | null }

/** Upload a clip and stream the analysis. Locally it goes straight to the
 *  server; on Vercel it goes to Blob storage first (function bodies are capped
 *  at 4.5 MB) and the function reads it from there. Resolves with the server's
 *  result, shape-checked; rejects with a StageError naming the failed stage. */
export async function analyzeLive(file: File, opts: LiveOptions, onEvent: (e: StageEvent) => void, onUpload?: (p: number) => void, signal?: AbortSignal): Promise<AnalyzeResult> {
  const raw = opts.health?.platform === 'vercel' ? await analyzeViaBlob(file, opts, onEvent, onUpload, signal) : await analyzeDirect(file, opts.color, onEvent, onUpload, signal)
  try {
    return checkResult(raw)
  } catch (e) {
    throw new StageError((e as Error).message, 'analyzing_moves')
  }
}

async function analyzeViaBlob(file: File, opts: LiveOptions, onEvent: (e: StageEvent) => void, onUpload?: (p: number) => void, signal?: AbortSignal): Promise<unknown> {
  if (opts.health?.uploads !== 'blob') throw new StageError('Live analysis on Vercel needs a Blob store: Vercel → Storage → Create → Blob, connect it to this project, then redeploy.', 'uploading')
  const { upload } = await import('@vercel/blob/client')
  let blob
  try {
    blob = await upload(`clips/${file.name}`, file, {
      access: 'public',
      handleUploadUrl: '/api/upload',
      contentType: file.type || 'video/mp4',
      multipart: file.size > 20 * 1024 * 1024,
      onUploadProgress: (e) => onUpload?.(e.percentage / 100),
      abortSignal: signal,
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new StageError(`Upload to Vercel Blob failed: ${(e as Error).message}`, 'uploading')
  }
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: blob.url, color: opts.color, name: file.name }),
    signal,
  })
  if (!res.body) throw new StageError(`The server answered ${res.status} with no stream.`, null)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buffer = ''
  let last: StageKey | null = 'uploading'
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += dec.decode(value, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      const e = JSON.parse(line)
      if (e.type === 'stage') { last = e.stage; onEvent(e) }
      else if (e.type === 'error') throw new StageError(e.message, e.stage ?? last)
      else if (e.type === 'result') return e
    }
  }
  throw new StageError(res.ok ? 'The analysis stopped without a result — it may have hit the function’s time limit.' : `Server ${res.status}`, last)
}

function analyzeDirect(file: File, color: string, onEvent: (e: StageEvent) => void, onUpload?: (p: number) => void, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    form.append('video', file)
    form.append('color', color)
    // XHR rather than fetch for upload progress; the response is NDJSON, read as it grows.
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/analyze')
    let seen = 0, buffer = '', settled = false
    let last: StageKey | null = 'uploading'
    const fail = (err: Error) => { if (!settled) { settled = true; reject(err) } }
    const pump = () => {
      buffer += xhr.responseText.slice(seen)
      seen = xhr.responseText.length
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        let e: any
        try { e = JSON.parse(line) } catch { fail(new StageError(`The server sent a line that is not JSON: ${line.slice(0, 120)}`, last)); return }
        if (e.type === 'stage') { last = e.stage; onEvent(e) }
        else if (e.type === 'result') { if (!settled) { settled = true; resolve(e) } }
        else if (e.type === 'error') { fail(new StageError(e.message, e.stage ?? last)); xhr.abort() }
      }
    }
    xhr.upload.onprogress = (e) => e.lengthComputable && onUpload?.(e.loaded / e.total)
    xhr.onprogress = pump
    xhr.onload = () => {
      pump()
      if (!settled) fail(new StageError(xhr.status >= 400 ? `Server ${xhr.status}: ${xhr.responseText.slice(0, 200)}` : 'The analysis stopped without a result.', last))
    }
    xhr.onerror = () => fail(new StageError('Could not reach the CLIMBR server. Is `npm run dev` running?', last))
    signal?.addEventListener('abort', () => { xhr.abort(); fail(new DOMException('Cancelled', 'AbortError')) })
    xhr.send(form)
  })
}

/** Development only: the browser's half of a run, filed beside the server's. */
export function reportRun(id: string, report: unknown) {
  if (!import.meta.env.DEV) return
  void fetch(`/api/debug/runs/${encodeURIComponent(id)}/client`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) }).catch(() => {})
}

export async function loadExample(id = 'green-vb'): Promise<Session> {
  const base = `${import.meta.env.BASE_URL}examples/${id}/`
  const get = async <T,>(f: string): Promise<T | undefined> => {
    try {
      const r = await fetch(base + f)
      return r.ok ? ((await r.json()) as T) : undefined
    } catch {
      return undefined
    }
  }
  const manifest = await get<ClimbrManifest>('climbr.json')
  const files = manifest?.files ?? {}
  const [climb, sequence, holds, comparison, coach] = await Promise.all([
    get<PipelineClimb>(files.climb ?? 'climb.json'),
    get<PipelineSequence>(files.sequence ?? 'sequence.json'),
    get<PipelineHold[]>(files.holds ?? 'holds.json'),
    get<PipelineComparison>(files.comparison ?? 'comparison.json'),
    get<any>('coach.json'),
  ])
  const parts: SessionParts = { manifest: coach ? { ...manifest!, coach } : manifest, climb, sequence, holds, comparison, baseUrl: base, kind: 'example' }
  const s = buildSession(parts)
  s.exampleId = id
  return s
}
