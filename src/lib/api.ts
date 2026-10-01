// The browser's side of the CLIMBR server: health, and the live analysis stream.

import { buildSession, type SessionParts } from './session'
import type { ClimbrManifest, PipelineClimb, PipelineComparison, PipelineHold, PipelineSequence, Session } from './types'

export interface Health {
  ok: boolean
  connected: boolean
  gateway?: string
  models?: { holds: string; pose: string; coach: string }
  ffmpeg?: boolean
  platform?: 'node' | 'vercel'
  uploads?: 'direct' | 'blob' | 'none'
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

export type StageKey = 'upload' | 'transcode' | 'holds' | 'pose' | 'read'
export interface StageEvent { type: 'stage'; stage: StageKey; status: 'running' | 'done' | 'skipped' | 'error'; detail?: string; progress?: number }
export interface AnalyzeResult { type: 'result'; id: string; video: string | null; meta: { width: number; height: number; fps: number; duration: number; color: string; prompt: string }; holds: any; poses: any; usage?: any }

export interface LiveOptions { color: string; health: Health | null; meta?: { width: number; height: number; duration: number } }

/** Upload a clip and stream the analysis. Locally it goes straight to the
 *  server; on Vercel it goes to Blob storage first (function bodies are capped
 *  at 4.5 MB) and the function reads it from there. */
export async function analyzeLive(file: File, opts: LiveOptions, onEvent: (e: StageEvent) => void, onUpload?: (p: number) => void, signal?: AbortSignal): Promise<AnalyzeResult> {
  if (opts.health?.platform !== 'vercel') return analyzeDirect(file, opts.color, onEvent, onUpload, signal)
  if (opts.health.uploads !== 'blob') throw new Error('Live analysis on Vercel needs a Blob store: Vercel → Storage → Create → Blob, connect it to this project, then redeploy.')
  const { upload } = await import('@vercel/blob/client')
  const blob = await upload(`clips/${file.name}`, file, {
    access: 'public',
    handleUploadUrl: '/api/upload',
    contentType: file.type || 'video/mp4',
    multipart: file.size > 20 * 1024 * 1024,
    onUploadProgress: (e) => onUpload?.(e.percentage / 100),
    abortSignal: signal,
  })
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: blob.url, color: opts.color, meta: opts.meta ? { ...opts.meta, fps: 30 } : undefined }),
    signal,
  })
  if (!res.body) throw new Error(`Server ${res.status}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buffer = ''
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
      if (e.type === 'stage') onEvent(e)
      else if (e.type === 'error') throw new Error(e.message)
      else if (e.type === 'result') return e
    }
  }
  throw new Error(res.ok ? 'The analysis ended without a result (it may have hit the function time limit).' : `Server ${res.status}`)
}

function analyzeDirect(file: File, color: string, onEvent: (e: StageEvent) => void, onUpload?: (p: number) => void, signal?: AbortSignal): Promise<AnalyzeResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    form.append('video', file)
    form.append('color', color)
    // XHR rather than fetch for upload progress; the response is NDJSON, read as it grows.
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/analyze')
    let seen = 0, buffer = ''
    let result: AnalyzeResult | null = null
    const pump = () => {
      buffer += xhr.responseText.slice(seen)
      seen = xhr.responseText.length
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        try {
          const e = JSON.parse(line)
          if (e.type === 'stage') onEvent(e)
          else if (e.type === 'result') result = e
          else if (e.type === 'error') { reject(new Error(e.message)); xhr.abort() }
        } catch { /* partial line */ }
      }
    }
    xhr.upload.onprogress = (e) => e.lengthComputable && onUpload?.(e.loaded / e.total)
    xhr.onprogress = pump
    xhr.onload = () => {
      pump()
      if (result) resolve(result)
      else if (xhr.status >= 400) reject(new Error(`Server ${xhr.status}`))
    }
    xhr.onerror = () => reject(new Error('Could not reach the CLIMBR server. Is `npm run dev` running?'))
    signal?.addEventListener('abort', () => { xhr.abort(); reject(new DOMException('Cancelled', 'AbortError')) })
    xhr.send(form)
  })
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
