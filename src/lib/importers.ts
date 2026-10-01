// Recognising what was dropped or pasted. A run of vision-demos writes a folder
// of artifacts; a VLM Run call returns a gateway envelope; CLIMBR exports a
// bundle. Each is identified by its shape, never by its file name.

import { analyzePayloads, isPosePayload, isSamPayload } from './analyze'
import { buildSession, type SessionParts } from './session'
import type { ClimbrManifest, PipelineClimb, PipelineComparison, PipelineHold, PipelineSequence, Session } from './types'

export type JsonKind = 'bundle' | 'manifest' | 'climb' | 'sequence' | 'holds' | 'comparison' | 'run' | 'sam' | 'pose' | 'unknown'

export interface Detected {
  id: string
  name: string
  size: number
  kind: JsonKind | 'video' | 'ply' | 'image' | 'csv' | 'text'
  label: string
  detail: string
  data?: any
  file?: File
  url?: string
}

export const KIND_LABEL: Record<Detected['kind'], string> = {
  bundle: 'CLIMBR session',
  manifest: 'CLIMBR manifest',
  climb: 'climb.json',
  sequence: 'sequence.json',
  holds: 'holds.json',
  comparison: 'comparison.json',
  run: 'run.json',
  sam: 'SAM 3.1 payload',
  pose: 'ViTPose+ payload',
  unknown: 'Unrecognised JSON',
  video: 'Video',
  ply: 'LiDAR point cloud',
  image: 'Wall image',
  csv: 'CSV',
  text: 'Text',
}

const uid = () => Math.random().toString(36).slice(2, 9)

/** An OpenAI-style chat completion wraps the payload as a JSON string. */
function unwrapCompletion(j: any): any {
  const c = j?.choices?.[0]?.message?.content
  if (typeof c === 'string') {
    try { return JSON.parse(c) } catch { return j }
  }
  return j
}

export function detectJson(raw: any): { kind: JsonKind; data: any; detail: string } {
  const j = unwrapCompletion(raw)
  if (j?.climbr && j?.session) return { kind: 'bundle', data: j, detail: `${j.session.title ?? 'session'} · ${j.session.holds?.length ?? 0} holds` }
  if (j?.climbr) return { kind: 'manifest', data: j, detail: j.title ?? 'manifest' }
  if (isSamPayload(j)) {
    const n = new Set((j.content.items ?? []).map((i: any) => i.track_id)).size
    return { kind: 'sam', data: j, detail: `${n} tracks · ${(j.content.frames ?? []).length} frames · ${j.model ?? 'sam3.1'}` }
  }
  if (isPosePayload(j)) return { kind: 'pose', data: j, detail: `${(j.content.items ?? []).length} poses · ${j.model ?? 'vitpose'}` }
  if (Array.isArray(j) && j.length && j.every((h: any) => Array.isArray(h?.bbox))) return { kind: 'holds', data: j, detail: `${j.length} hold masks${j.some((h: any) => 'depth' in h) ? ' · 3D' : ''}` }
  if (Array.isArray(j?.attempts) && ('reference' in j || 'n_attempts' in j)) return { kind: 'comparison', data: j, detail: `${j.attempts.length} attempts · shortest ${j.shortest ?? '—'}` }
  if (Array.isArray(j?.moves) && (j.utilization || 'holds_detected' in j || 'completion_frame' in j)) return { kind: 'climb', data: j, detail: `${j.moves.length} moves · ${j.elapsed_seconds != null ? j.elapsed_seconds.toFixed(2) + ' s' : 'no top-out'}` }
  if (Array.isArray(j?.sequence) && ('per_limb_sequence' in j || 'first_limb_by_hold' in j || 'sequence_aligned' in j)) return { kind: 'sequence', data: j, detail: `${j.sequence.join(' › ')}` }
  if (j?.stamp && j?.outputs) return { kind: 'run', data: j, detail: `run ${j.stamp}` }
  if (j?.climb && Array.isArray(j?.climb?.sequence)) return { kind: 'run', data: j, detail: 'run.json' }
  return { kind: 'unknown', data: j, detail: Array.isArray(j) ? `array of ${j.length}` : `keys: ${Object.keys(j ?? {}).slice(0, 5).join(', ')}` }
}

export async function detectFile(file: File): Promise<Detected> {
  const name = file.name
  const lower = name.toLowerCase()
  const base = { id: uid(), name, size: file.size, file }
  if (file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/.test(lower)) return { ...base, kind: 'video', label: KIND_LABEL.video, detail: fmtBytes(file.size), url: URL.createObjectURL(file) }
  if (lower.endsWith('.ply')) return { ...base, kind: 'ply', label: KIND_LABEL.ply, detail: `${fmtBytes(file.size)} · meters`, url: URL.createObjectURL(file) }
  if (file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/.test(lower)) return { ...base, kind: 'image', label: lower.includes('wall') ? 'Wall image' : 'Image', detail: fmtBytes(file.size), url: URL.createObjectURL(file) }
  if (lower.endsWith('.csv')) return { ...base, kind: 'csv', label: KIND_LABEL.csv, detail: 'kept for reference' }
  const text = await file.text()
  try {
    const d = detectJson(JSON.parse(text))
    return { ...base, kind: d.kind, label: KIND_LABEL[d.kind], detail: d.detail, data: d.data }
  } catch {
    return { ...base, kind: 'text', label: KIND_LABEL.text, detail: 'not JSON' }
  }
}

export function detectPasted(text: string): Detected[] {
  const out: Detected[] = []
  const trimmed = text.trim()
  if (!trimmed) return out
  // One document, or several pasted back to back.
  const docs = splitJsonDocuments(trimmed)
  for (const doc of docs) {
    try {
      const d = detectJson(JSON.parse(doc))
      out.push({ id: uid(), name: 'pasted', size: doc.length, kind: d.kind, label: KIND_LABEL[d.kind], detail: d.detail, data: d.data })
    } catch (e) {
      out.push({ id: uid(), name: 'pasted', size: doc.length, kind: 'text', label: 'Invalid JSON', detail: (e as Error).message.slice(0, 80) })
    }
  }
  return out
}

function splitJsonDocuments(text: string): string[] {
  const docs: string[] = []
  let depth = 0, start = -1, inStr = false, esc = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') { if (depth === 0) start = i; depth++ }
    else if (c === '}' || c === ']') { depth--; if (depth === 0 && start >= 0) { docs.push(text.slice(start, i + 1)); start = -1 } }
  }
  return docs.length ? docs : [text]
}

export interface Assembly {
  ready: boolean
  needsLive: boolean // a video and nothing read from it yet
  canAnalyzeLocally: boolean // raw gateway payloads present
  summary: string
  missing: string[]
}

export function assess(items: Detected[]): Assembly {
  const has = (k: Detected['kind']) => items.some((i) => i.kind === k)
  const missing: string[] = []
  const readable = has('bundle') || has('climb') || has('sequence') || has('comparison')
  const raw = has('sam') && has('pose')
  if (has('sam') && !has('pose')) missing.push('ViTPose+ payload (pose) to read the climb from SAM 3.1 holds')
  if (has('pose') && !has('sam') && !has('holds')) missing.push('SAM 3.1 payload or holds.json for the hold shapes')
  if (readable && !has('holds') && !has('bundle') && !raw) missing.push('holds.json (optional) for real hold shapes')
  if (!has('video') && !has('bundle')) missing.push('the climb video (optional) for the synced replay')
  const needsLive = has('video') && !readable && !raw && !(has('holds') && has('pose'))
  return {
    ready: readable || raw || (has('holds') && has('pose')) || has('bundle'),
    needsLive,
    canAnalyzeLocally: raw || (has('holds') && has('pose')),
    summary: readable ? 'Pipeline output detected' : raw ? 'Raw VLM Run output — CLIMBR will read the route in your browser' : needsLive ? 'Video only — analyze it live with VLM Run' : 'Add a climb',
    missing,
  }
}

export interface BuildOptions {
  title?: string
  climber?: string
  color?: string
  grade?: string
  videoAspect?: number
}

/** Everything dropped or pasted → one Session. */
export function sessionFromItems(items: Detected[], opts: BuildOptions = {}): { session: Session; warnings: string[] } {
  const pick = <T,>(k: JsonKind) => items.find((i) => i.kind === k)?.data as T | undefined
  const bundle = pick<any>('bundle')
  const video = items.find((i) => i.kind === 'video')
  const ply = items.find((i) => i.kind === 'ply')
  const wall = items.find((i) => i.kind === 'image' && /wall/i.test(i.name))
  if (bundle) {
    const s: Session = { ...bundle.session, kind: 'import' }
    if (video?.url) s.video = { ...(s.video ?? { offset: 0 }), src: video.url }
    else if (s.video?.src?.startsWith('blob:')) s.video = undefined
    return { session: s, warnings: [] }
  }

  const warnings: string[] = []
  const parts: SessionParts = {
    manifest: pick<ClimbrManifest>('manifest'),
    climb: pick<PipelineClimb>('climb'),
    sequence: pick<PipelineSequence>('sequence'),
    holds: pick<PipelineHold[]>('holds'),
    comparison: pick<PipelineComparison>('comparison'),
    videoUrl: video?.url,
    wallUrl: wall?.url,
    plyUrl: ply?.url,
    kind: 'import',
  }
  const run = pick<any>('run')
  if (!parts.climb && run?.climb) parts.climb = { ...run.climb, route: run.route, fps: run.converted?.fps }

  const sam = pick<any>('sam'), pose = pick<any>('pose')
  if (!parts.climb && pose && (sam || parts.holds)) {
    const aspect = pose.video_width && pose.video_height ? pose.video_width / pose.video_height : opts.videoAspect
    const r = analyzePayloads(sam, pose, { color: opts.color ?? 'green', aspect, holds: parts.holds })
    parts.climb = r.climb
    parts.holds = r.holds
    warnings.push(...r.warnings)
    parts.manifest = {
      climbr: 1,
      ...(parts.manifest ?? {}),
      torso: r.torso,
      canvas: { width: pose.video_width ?? 9, height: pose.video_height ?? 16 },
      video: video ? { src: video.url!, clock_offset: (r.startFrame ?? 0) / (r.climb.fps ?? 30), affine: [[1, 0, 0], [0, 1, 0]], overlays: 'none' } : undefined,
      models: { holds: sam?.model ?? 'facebook/sam3.1', pose: pose?.model ?? 'usyd-community/vitpose-plus-large' },
    }
  }

  if (parts.holds?.some((h) => typeof h.depth === 'number') && !parts.manifest?.canvas) {
    // rock_climbing_3d flattens the route face-on into its own bounding box.
    parts.manifest = { climbr: 1, ...(parts.manifest ?? {}), canvas: { width: 1, height: 1.6 } }
  }
  if (!parts.manifest?.canvas && opts.videoAspect) {
    parts.manifest = { climbr: 1, ...(parts.manifest ?? {}), canvas: { width: opts.videoAspect * 1000, height: 1000 } }
  }
  const session = buildSession({
    ...parts,
    meta: {
      title: opts.title || undefined,
      climber: opts.climber || undefined,
      ...(opts.color || opts.grade ? { route: { color: opts.color ?? parts.climb?.route?.color ?? 'green', grade: opts.grade ?? parts.climb?.route?.grade ?? '—' } } : {}),
    },
  })
  if (video && session.video && !parts.manifest?.video) {
    session.video.affine = [[1, 0, 0], [0, 1, 0]]
  }
  return { session, warnings }
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

/** Walk a dropped folder (a whole data/output/<stamp>/ directory, say). */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const entries = [...dt.items].map((i) => (i as any).webkitGetAsEntry?.()).filter(Boolean)
  if (!entries.length) return [...dt.files]
  const out: File[] = []
  const walk = async (entry: any): Promise<void> => {
    if (entry.isFile) {
      out.push(await new Promise<File>((res, rej) => entry.file(res, rej)))
    } else if (entry.isDirectory) {
      const reader = entry.createReader()
      const read = () => new Promise<any[]>((res, rej) => reader.readEntries(res, rej))
      for (let batch = await read(); batch.length; batch = await read()) for (const e of batch) await walk(e)
    }
  }
  for (const e of entries) await walk(e)
  return out.filter((f) => !f.name.startsWith('.'))
}
