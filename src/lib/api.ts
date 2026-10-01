// The browser's side of the CLIMBR server: health, and the live analysis stream.

import { buildSession, type SessionParts } from './session'
import type { ClimbrManifest, PipelineClimb, PipelineComparison, PipelineHold, PipelineSequence, Session } from './types'

export interface Health {
  ok: boolean
  connected: boolean
  gateway?: string
  models?: { holds: string; pose: string; coach: string }
  ffmpeg?: boolean
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
export interface AnalyzeResult { type: 'result'; id: string; video: string; meta: { width: number; height: number; fps: number; duration: number; color: string; prompt: string }; holds: any; poses: any; usage?: any }

export function analyzeLive(file: File, opts: { color: string }, onEvent: (e: StageEvent) => void, onUpload?: (p: number) => void, signal?: AbortSignal): Promise<AnalyzeResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    form.append('video', file)
    form.append('color', opts.color)
    // XHR rather than fetch for upload progress; the response is NDJSON, read as it grows.
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/analyze')
    let seen = 0, buffer = ''
    let result: AnalyzeResult | null = null
    const pump = () => {
      const chunk = xhr.responseText.slice(seen)
      seen = xhr.responseText.length
      buffer += chunk
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
